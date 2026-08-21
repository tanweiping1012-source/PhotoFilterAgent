import Foundation

// photocurate —— 照片筛选 agent 的本地分析进程。
//
// 它是 agent 的“免费工具”：分类、相似家族、技术质量全部在本机算完，一次网络都不走。
// 输出里永远没有绝对路径、文件名和绝对拍摄时间——匿名 ID 与真实路径的映射只留在
// 工作目录的 index.json 里，供本进程自己解析 preview 用，绝不进入模型可见的任何一步。

// MARK: - 命令行解析

struct Options {
    var command = ""
    var positional: [String] = []
    var flags: [String: String] = [:]

    static func parse(_ argv: [String]) -> Options {
        var options = Options()
        var rest = Array(argv.dropFirst())
        options.command = rest.first ?? ""
        rest = Array(rest.dropFirst())
        var index = 0
        while index < rest.count {
            let token = rest[index]
            if token.hasPrefix("--") {
                let key = String(token.dropFirst(2))
                if index + 1 < rest.count, !rest[index + 1].hasPrefix("--") {
                    options.flags[key] = rest[index + 1]
                    index += 2
                } else {
                    options.flags[key] = "true"
                    index += 1
                }
            } else {
                options.positional.append(token)
                index += 1
            }
        }
        return options
    }

    func flag(_ name: String) -> String? { flags[name] }
    func int(_ name: String) -> Int? { flags[name].flatMap { Int($0) } }
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data(("photocurate: " + message + "\n").utf8))
    exit(2)
}

func emit(_ value: Any) {
    guard JSONSerialization.isValidJSONObject(value),
          let data = try? JSONSerialization.data(
              withJSONObject: value,
              options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
          ) else {
        fail("无法序列化结果")
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

// MARK: - 匿名索引

/// 匿名 ID ↔ 真实路径。写在工作目录里，只有本进程读；模型永远拿不到它。
struct AnonymousIndex: Codable {
    var root: String
    var byAnonymous: [String: String]

    static func url(in workdir: String) -> URL {
        URL(fileURLWithPath: workdir, isDirectory: true)
            .appendingPathComponent("index.json")
    }

    func write(to workdir: String) throws {
        try FileManager.default.createDirectory(
            atPath: workdir, withIntermediateDirectories: true
        )
        let data = try JSONEncoder().encode(self)
        try data.write(to: Self.url(in: workdir), options: .atomic)
    }

    static func read(from workdir: String) throws -> AnonymousIndex {
        let data = try Data(contentsOf: url(in: workdir))
        return try JSONDecoder().decode(AnonymousIndex.self, from: data)
    }
}

// MARK: - analyze

struct Prepared {
    let photos: [PhotoItem]
    let families: CandidateFamilyIndex
    let anonymousByLocal: [String: String]
    let workdir: String
    let earliest: Date?
}

/// 递归扫描 → 并行分析 → 相似家族 → 清晰度风险 → 家族内本地排序。
/// analyze 与 select 共用它，保证两条命令看到的是同一份世界。
func prepare(folder: String, options: Options) async -> Prepared {
    let folderURL = URL(fileURLWithPath: folder, isDirectory: true)
    guard FileManager.default.fileExists(atPath: folderURL.path) else {
        fail("目录不存在: \(folder)")
    }
    let workdir = options.flag("workdir")
        ?? FileManager.default.temporaryDirectory
            .appendingPathComponent("photocurate").path

    var urls = PhotoAnalysisPipeline.imageURLs(in: folderURL)
    guard !urls.isEmpty else { fail("目录里没有受支持的照片") }
    if let limit = options.int("limit"), limit > 0, urls.count > limit {
        // 取样必须跨越整个目录，否则只会拿到一个子文件夹的照片，
        // 人物/风景的比例会被取样方式而不是真实内容决定。
        let step = Double(urls.count) / Double(limit)
        urls = (0..<limit).map { urls[min(urls.count - 1, Int(Double($0) * step))] }
    }

    var results: [String: PhotoAnalysisResult] = [:]
    let collected = Collector()
    await PhotoAnalysisPipeline.analyze(urls: urls, batchSize: 32) { batch in
        await collected.add(batch)
    }
    for result in await collected.all() { results[result.photoID] = result }

    var photos = urls.map { url -> PhotoItem in
        var photo = PhotoItem(url: url)
        if let result = results[photo.id] {
            photo.captureDate = result.captureDate
            photo.perceptualHash = result.perceptualHash
            photo.technicalQuality = result.technicalQuality
            photo.curationCategory = result.curationCategory
        }
        return photo
    }

    photos = SimilarityGrouper.assigningGroups(to: photos)
    photos = TechnicalQualityAnalyzer.assigningSharpnessRisks(to: photos)
    photos = LocalCandidateRanker.assigningRecommendations(to: photos)
    let families = CandidateFamilyIndex(photos: photos)

    // 匿名 ID 按稳定顺序分配，同一目录重复分析得到同样的编号。
    var index = AnonymousIndex(root: folderURL.standardizedFileURL.path, byAnonymous: [:])
    var anonymousByLocal: [String: String] = [:]
    for (offset, photo) in photos.enumerated() {
        let anonymous = String(format: "p%03d", offset + 1)
        index.byAnonymous[anonymous] = photo.url.standardizedFileURL.path
        anonymousByLocal[photo.id] = anonymous
    }
    do { try index.write(to: workdir) } catch { fail("无法写入索引: \(error)") }

    // 时间一律相对化：绝对拍摄时间是元数据，不该出现在模型可见的表里。
    let earliest = photos.compactMap(\.captureDate).min()

    var familyMembers: [String: [String]] = [:]
    for photo in photos {
        guard let familyID = families.familyID(for: photo.id),
              let anonymous = anonymousByLocal[photo.id] else { continue }
        familyMembers[familyID, default: []].append(anonymous)
    }
    var familyLabel: [String: String] = [:]
    for (offset, familyID) in familyMembers.keys.sorted().enumerated() {
        familyLabel[familyID] = String(format: "F%02d", offset + 1)
    }

    func metrics(_ photo: PhotoItem) -> [String: Any] {
        guard let quality = photo.technicalQuality else {
            return ["sharp": 0, "range": 0, "clip": 100, "risk": ["unreadable"]]
        }
        let clipping = quality.shadowClippingRatio + quality.highlightClippingRatio
        return [
            "sharp": Int((min(max(quality.sharpness, 0), 1) * 100).rounded()),
            "range": Int((Double(quality.dynamicRange) / 255 * 100).rounded()),
            "clip": Int((min(max(clipping, 0), 1) * 100).rounded()),
            "risk": quality.risks.map(\.rawValue),
        ]
    }

    let rows: [[String: Any]] = photos.compactMap { photo in
        guard let anonymous = anonymousByLocal[photo.id] else { return nil }
        var row: [String: Any] = [
            "id": anonymous,
            "category": photo.curationCategory?.rawValue ?? "scenery",
        ]
        row.merge(metrics(photo)) { current, _ in current }
        if let familyID = families.familyID(for: photo.id),
           let label = familyLabel[familyID] {
            row["family"] = label
        }
        if let captureDate = photo.captureDate, let earliest {
            row["t"] = Int(captureDate.timeIntervalSince(earliest).rounded())
        }
        row["local_top"] = photo.localRecommendations.contains(where: \.isTopCandidate)
        return row
    }

    return Prepared(
        photos: photos,
        families: families,
        anonymousByLocal: anonymousByLocal,
        workdir: workdir,
        earliest: earliest
    )
}

/// 输出候选表（无路径、无文件名、时间相对化）。
func runAnalyze(_ options: Options) async {
    guard let folder = options.positional.first else {
        fail("用法: photocurate analyze <目录> [--limit N] [--workdir <路径>]")
    }
    let prepared = await prepare(folder: folder, options: options)
    let photos = prepared.photos
    let families = prepared.families
    let anonymousByLocal = prepared.anonymousByLocal
    let earliest = prepared.earliest
    let workdir = prepared.workdir

    var familyMembers: [String: [String]] = [:]
    for photo in photos {
        guard let familyID = families.familyID(for: photo.id),
              let anonymous = anonymousByLocal[photo.id] else { continue }
        familyMembers[familyID, default: []].append(anonymous)
    }
    var familyLabel: [String: String] = [:]
    for (offset, familyID) in familyMembers.keys.sorted().enumerated() {
        familyLabel[familyID] = String(format: "F%02d", offset + 1)
    }

    func metrics(_ photo: PhotoItem) -> [String: Any] {
        guard let quality = photo.technicalQuality else {
            return ["sharp": 0, "range": 0, "clip": 100, "risk": ["unreadable"]]
        }
        let clipping = quality.shadowClippingRatio + quality.highlightClippingRatio
        return [
            "sharp": Int((min(max(quality.sharpness, 0), 1) * 100).rounded()),
            "range": Int((Double(quality.dynamicRange) / 255 * 100).rounded()),
            "clip": Int((min(max(clipping, 0), 1) * 100).rounded()),
            "risk": quality.risks.map(\.rawValue),
        ]
    }

    let rows: [[String: Any]] = photos.compactMap { photo in
        guard let anonymous = anonymousByLocal[photo.id] else { return nil }
        var row: [String: Any] = [
            "id": anonymous,
            "category": photo.curationCategory?.rawValue ?? "scenery",
        ]
        row.merge(metrics(photo)) { current, _ in current }
        if let familyID = families.familyID(for: photo.id),
           let label = familyLabel[familyID] {
            row["family"] = label
        }
        if let captureDate = photo.captureDate, let earliest {
            row["t"] = Int(captureDate.timeIntervalSince(earliest).rounded())
        }
        row["local_top"] = photo.localRecommendations.contains(where: \.isTopCandidate)
        return row
    }

    let peopleCount = photos.filter { $0.curationCategory == .people }.count
    emit([
        "workdir": workdir,
        "photo_count": photos.count,
        "people_count": peopleCount,
        "scenery_count": photos.count - peopleCount,
        "family_count": familyMembers.count,
        "families": familyMembers
            .sorted { $0.key < $1.key }
            .compactMap { entry -> [String: Any]? in
                guard entry.value.count > 1, let label = familyLabel[entry.key] else { return nil }
                return ["id": label, "members": entry.value.sorted()]
            },
        "candidates": rows,
    ])
}

/// 分析回调是 `@Sendable` 且跨并发路数调用，结果必须收在 actor 里。
actor Collector {
    private var results: [PhotoAnalysisResult] = []
    func add(_ batch: [PhotoAnalysisResult]) { results.append(contentsOf: batch) }
    func all() -> [PhotoAnalysisResult] { results }
}

// MARK: - select（确定性选片；无 Key 时即产品本身，有 Key 时是 agent 的兜底）

func runSelect(_ options: Options) async {
    guard let folder = options.positional.first else {
        fail("用法: photocurate select <目录> --people N --scenery M [--limit N] [--workdir <路径>]")
    }
    let prepared = await prepare(folder: folder, options: options)
    let peopleTarget = options.int("people") ?? 6
    let sceneryTarget = options.int("scenery") ?? 6

    var payload: [String: Any] = ["workdir": prepared.workdir, "photo_count": prepared.photos.count]
    var allKeep: [String] = []
    for (category, target) in [
        (PhotoCurationCategory.people, peopleTarget),
        (PhotoCurationCategory.scenery, sceneryTarget),
    ] {
        let outcome = LocalSelection.select(
            photos: prepared.photos,
            families: prepared.families,
            category: category,
            target: target
        )
        let anonymous = outcome.keep.compactMap { prepared.anonymousByLocal[$0] }
        allKeep.append(contentsOf: anonymous)
        payload[category.rawValue] = [
            "target": target,
            "selected": anonymous,
            "selected_scores": outcome.keep.compactMap { id -> [String: Any]? in
                guard let anon = prepared.anonymousByLocal[id] else { return nil }
                return ["id": anon, "score": outcome.scores[id] ?? 0]
            },
            "pool_size": outcome.scores.count,
            "all_scores": Dictionary(uniqueKeysWithValues: outcome.scores.compactMap { entry -> (String, Int)? in
                guard let anon = prepared.anonymousByLocal[entry.key] else { return nil }
                return (anon, entry.value)
            }),
        ]
    }
    payload["keep"] = allKeep
    payload["method"] = "local-deterministic"
    emit(payload)
}

// MARK: - preview

/// 把一张照片重编码成无元数据 JPEG 并以 base64 输出。原图只读，绝不修改。
func runPreview(_ options: Options) {
    guard let anonymous = options.positional.first else {
        fail("用法: photocurate preview <匿名ID> --workdir <路径> [--detail low|standard|high]")
    }
    guard let workdir = options.flag("workdir") else { fail("缺少 --workdir") }
    guard let index = try? AnonymousIndex.read(from: workdir) else {
        fail("读不到索引，请先运行 analyze")
    }
    guard let path = index.byAnonymous[anonymous] else { fail("未知的照片 ID: \(anonymous)") }

    let detail = options.flag("detail") ?? "low"
    guard let size = AIReviewPreviewSize(detail: detail) else {
        fail("未知档位: \(detail)（可用 low / standard / high）")
    }
    do {
        let data = try AIReviewPreviewEncoder.jpegData(
            for: URL(fileURLWithPath: path),
            maximumPixelSize: size.maximumPixelSize
        )
        emit([
            "id": anonymous,
            "detail": size.detailName,
            "max_pixel": size.maximumPixelSize,
            "bytes": data.count,
            "jpeg_base64": data.base64EncodedString(),
        ])
    } catch {
        fail("无法生成预览: \(error)")
    }
}

// MARK: - resolve（导出用，只在本机解析，不进模型上下文）

func runResolve(_ options: Options) {
    guard let workdir = options.flag("workdir") else { fail("缺少 --workdir") }
    guard let index = try? AnonymousIndex.read(from: workdir) else {
        fail("读不到索引，请先运行 analyze")
    }
    let resolved = options.positional.compactMap { id -> [String: String]? in
        guard let path = index.byAnonymous[id] else { return nil }
        return ["id": id, "path": path, "filename": URL(fileURLWithPath: path).lastPathComponent]
    }
    emit(["root": index.root, "resolved": resolved])
}

// MARK: - export（只复制，绝不移动/删除/改名原图）

func runExport(_ options: Options) {
    guard let workdir = options.flag("workdir") else { fail("缺少 --workdir") }
    guard let destination = options.flag("to") else { fail("缺少 --to <目标目录>") }
    guard let index = try? AnonymousIndex.read(from: workdir) else {
        fail("读不到索引，请先运行 analyze")
    }
    let destinationURL = URL(fileURLWithPath: destination, isDirectory: true)
    // 导出目录不得落在原图目录内部：那既是往只读目录里写，也会让下次扫描把副本当成新照片。
    if destinationURL.standardizedFileURL.path.hasPrefix(index.root + "/") {
        fail("导出目录不能位于原图目录内部")
    }

    var copied: [[String: String]] = []
    for id in options.positional {
        guard let path = index.byAnonymous[id] else { continue }
        let source = URL(fileURLWithPath: path)
        let target = destinationURL.appendingPathComponent(source.lastPathComponent)
        do {
            try FileManager.default.createDirectory(
                at: destinationURL, withIntermediateDirectories: true
            )
            if FileManager.default.fileExists(atPath: target.path) {
                try FileManager.default.removeItem(at: target)
            }
            try FileManager.default.copyItem(at: source, to: target)
            copied.append(["id": id, "filename": source.lastPathComponent])
        } catch {
            fail("复制失败 \(source.lastPathComponent): \(error)")
        }
    }
    emit(["destination": destinationURL.path, "copied": copied, "count": copied.count])
}

// MARK: - 入口

let options = Options.parse(CommandLine.arguments)
switch options.command {
case "analyze": await runAnalyze(options)
case "select": await runSelect(options)
case "preview": runPreview(options)
case "resolve": runResolve(options)
case "export": runExport(options)
default:
    print("""
    photocurate —— 照片筛选 agent 的本地分析进程

    analyze <目录> [--limit N] [--workdir <路径>]
        递归扫描并分析：人物/风景分类、相似家族、清晰度与曝光。
        输出候选表（无路径、无文件名、时间相对化）。

    preview <匿名ID> --workdir <路径> [--detail low|standard|high]
        输出无元数据 JPEG 的 base64（512 / 1024 / 1536px）。

    resolve <匿名ID...> --workdir <路径>
        本机解析匿名 ID 为真实路径（不进模型上下文）。

    export <匿名ID...> --workdir <路径> --to <目标目录>
        只复制到目标目录；原图不移动、不删除、不改名。
    """)
}
