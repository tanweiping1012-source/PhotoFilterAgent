import CryptoKit
import Foundation

// photofilter —— 照片筛选 agent 的本地分析进程。
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
    FileHandle.standardError.write(Data(("photofilter: " + message + "\n").utf8))
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

/// Exclusions travel as one JSON array argument. This keeps every relative path
/// as data (never shell syntax) and lets malformed input fail before enumeration.
func excludedRelativePaths(from options: Options) -> [String] {
    guard let raw = options.flag("exclude-relative-json") else { return [] }
    guard let data = raw.data(using: .utf8),
          let paths = try? JSONDecoder().decode([String].self, from: data) else {
        fail("--exclude-relative-json 必须是字符串 JSON 数组")
    }
    return paths
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
    let datasetFingerprint: String
}

/// 当前候选集合的轻量内容身份。
///
/// 路径、文件大小和纳秒级修改时间只在本机进入哈希；模型只看到摘要。它避免目录内容
/// 变化后复用旧的匿名 ID、分数和导出映射。这里不读取整张原图，因此不会把一次本地
/// 扫描的 I/O 放大一倍。
func datasetFingerprint(root: URL, urls: [URL]) -> String {
    var hasher = SHA256()
    let rootPath = root.standardizedFileURL.path
    for url in urls {
        let path = url.standardizedFileURL.path
        let relative = path.hasPrefix(rootPath + "/")
            ? String(path.dropFirst(rootPath.count + 1))
            : path
        let values = try? url.resourceValues(forKeys: [
            .fileSizeKey,
            .contentModificationDateKey,
        ])
        let modifiedNanoseconds = values?.contentModificationDate
            .map { Int64(($0.timeIntervalSince1970 * 1_000_000_000).rounded()) }
            ?? -1
        let record = "\(relative)\u{0}\(values?.fileSize ?? -1)\u{0}\(modifiedNanoseconds)\n"
        hasher.update(data: Data(record.utf8))
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
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
            .appendingPathComponent("photofilter").path

    let excludedPaths = excludedRelativePaths(from: options)
    let discoveredURLs: [URL]
    do {
        discoveredURLs = try PhotoAnalysisPipeline.imageURLs(
            in: folderURL,
            excludedRelativePaths: excludedPaths
        )
    } catch {
        fail(error.localizedDescription)
    }
    var urls = discoveredURLs
    guard !urls.isEmpty else { fail("目录里没有受支持的照片") }
    if let limit = options.int("limit"), limit > 0, urls.count > limit {
        // 取样必须跨越整个目录，否则只会拿到一个子文件夹的照片，
        // 人物/风景的比例会被取样方式而不是真实内容决定。
        let step = Double(urls.count) / Double(limit)
        urls = (0..<limit).map { urls[min(urls.count - 1, Int(Double($0) * step))] }
    }
    let fingerprint = datasetFingerprint(root: folderURL, urls: urls)

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
            photo.portraitQuality = result.portraitQuality
            photo.curationCategory = result.curationCategory
        }
        return photo
    }

    photos = SimilarityGrouper.assigningGroups(to: photos)
    photos = TechnicalQualityAnalyzer.assigningSharpnessRisks(to: photos)
    photos = LocalCandidateRanker.assigningRecommendations(to: photos)
    let families = CandidateFamilyIndex(photos: photos)

    // 匿名 ID 必须稳定，但不能沿用递归路径顺序：如果测试集里恰好有 oracle
    // 子目录，连续的一段 ID 会把其目录归属侧漏给上层 Agent。以整个
    // 数据集指纹作为 salt，对本地 photo id 排序后再编号；同一数据集可复现，
    // 路径分组却无法从 p001/p002… 推断。salt 与真实路径都不会离开本机。
    func anonymousOrderKey(_ photo: PhotoItem) -> String {
        let material = "\(fingerprint)\u{0}\(photo.id)"
        return SHA256.hash(data: Data(material.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }
    let anonymizedPhotos = photos.sorted {
        let left = anonymousOrderKey($0)
        let right = anonymousOrderKey($1)
        return left == right ? $0.id < $1.id : left < right
    }
    var index = AnonymousIndex(root: folderURL.standardizedFileURL.path, byAnonymous: [:])
    var anonymousByLocal: [String: String] = [:]
    for (offset, photo) in anonymizedPhotos.enumerated() {
        let anonymous = String(format: "p%03d", offset + 1)
        index.byAnonymous[anonymous] = photo.url.standardizedFileURL.path
        anonymousByLocal[photo.id] = anonymous
    }
    do { try index.write(to: workdir) } catch { fail("无法写入索引: \(error)") }

    // 时间一律相对化：绝对拍摄时间是元数据，不该出现在模型可见的表里。
    let earliest = photos.compactMap(\.captureDate).min()

    return Prepared(
        photos: photos,
        families: families,
        anonymousByLocal: anonymousByLocal,
        workdir: workdir,
        earliest: earliest,
        datasetFingerprint: fingerprint
    )
}

/// 输出候选表（无路径、无文件名、时间相对化）。
func runAnalyze(_ options: Options) async {
    guard let folder = options.positional.first else {
        fail("用法: photofilter analyze <目录> [--limit N] [--workdir <路径>]")
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
        // 人脸事实必须直接摆出来。模型在 512px 上看得清眼睛是闭的——实测它会明说
        // "闭目瞬间富有感染力"——但它把闭眼当成"自然、有情绪"而加分。
        // 与其指望它领会，不如把本机免费算出的事实交给它。
        if let portrait = photo.portraitQuality {
            row["face"] = portrait.summary
            row["face_quality"] = Int((portrait.captureQuality * 100).rounded())
            if portrait.eyesLikelyClosed { row["eyes_closed"] = true }
        }
        return row
    }

    // 连拍组默认折叠：只露一个占位代表，其余标记为 collapsed。
    // 上一次实测里模型无视了 78 组连拍、对每张单独打分——而连拍恰恰是"哪张睁着眼"
    // 唯一能被可靠判出来的地方。折叠之后，想动这些照片必须显式 compare。
    //
    // 代表不能按 ID 顺序取。全库实测 39 组覆盖 426 张，最大一组 49 张——按 ID 取
    // 等于随机指定一张当门面，闭眼那张照样会顶上来（F25 的代表就是"脸质量54 眼睛闭"）。
    // 那正是这次要修的 bug，只是换了一层重新出现。
    //
    // 改用本机已经算出的免费事实排序：先排除闭眼，再看人脸质量，再看清晰度，
    // ID 兜底保证跨机器确定。这只决定"默认露哪张"——冠军仍然由 compare /
    // resolve_family 定，代表选得好只是让模型不必为每组都花一次比较的钱。
    var rowByID: [String: [String: Any]] = [:]
    for row in rows {
        guard let id = row["id"] as? String else { continue }
        rowByID[id] = row
    }
    func placeholderRank(_ id: String) -> (Int, Int, Int, String) {
        let row = rowByID[id] ?? [:]
        let closed = (row["eyes_closed"] as? Bool ?? false) ? 1 : 0
        let faceQuality = row["face_quality"] as? Int ?? -1
        let sharp = row["sharp"] as? Int ?? 0
        return (closed, -faceQuality, -sharp, id)
    }
    var collapsed: Set<String> = []
    for (_, members) in familyMembers where members.count > 1 {
        let ordered = members.sorted { placeholderRank($0) < placeholderRank($1) }
        collapsed.formUnion(ordered.dropFirst())
    }

    let peopleCount = photos.filter { $0.curationCategory == .people }.count
    emit([
        "workdir": workdir,
        "dataset_fingerprint": prepared.datasetFingerprint,
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
        "collapsed_by_family": collapsed.sorted(),
        "candidates": rows.map { row -> [String: Any] in
            guard let id = row["id"] as? String, collapsed.contains(id) else { return row }
            var row = row
            row["collapsed"] = true
            return row
        },
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
        fail("用法: photofilter select <目录> --people N --scenery M [--limit N] [--workdir <路径>]")
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
        fail("用法: photofilter preview <匿名ID> --workdir <路径> [--detail low|standard|high]")
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

// MARK: - content-hashes（只读冻结 receipt）

struct ContentHashRecord: Equatable {
    let id: String
    let sha256: String
}

enum ContentHashError: Error, Equatable, LocalizedError {
    case duplicateID(String)
    case unknownID(String)
    case unreadableID(String)

    var errorDescription: String? {
        switch self {
        case .duplicateID(let id): return "重复的照片 ID: \(id)"
        case .unknownID(let id): return "未知的照片 ID: \(id)"
        case .unreadableID(let id): return "无法读取照片 ID: \(id)"
        }
    }
}

/// Hash a file incrementally so a receipt never requires loading an original
/// photo into memory in full.
func streamSHA256(for url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var hasher = SHA256()
    while true {
        guard let chunk = try handle.read(upToCount: 1024 * 1024), !chunk.isEmpty else { break }
        hasher.update(data: chunk)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
}

/// Validate the complete request before reading any original. Unknown and
/// duplicate IDs therefore fail closed without returning a partial receipt.
func contentHashRecords(ids: [String], index: AnonymousIndex) throws -> [ContentHashRecord] {
    var seen: Set<String> = []
    var sources: [(String, URL)] = []
    sources.reserveCapacity(ids.count)
    let resolvedRoot = URL(fileURLWithPath: index.root, isDirectory: true)
        .resolvingSymlinksInPath().standardizedFileURL.path
    func remainsInsideSourceRoot(_ url: URL) -> Bool {
        let resolved = url.resolvingSymlinksInPath().standardizedFileURL.path
        return resolved == resolvedRoot || resolved.hasPrefix(resolvedRoot + "/")
    }
    for id in ids {
        guard seen.insert(id).inserted else { throw ContentHashError.duplicateID(id) }
        guard let path = index.byAnonymous[id] else { throw ContentHashError.unknownID(id) }
        let source = URL(fileURLWithPath: path)
        // The source may have been replaced after analyze. Never let a later
        // symlink swap turn a receipt hash into a read outside the authorized root.
        guard remainsInsideSourceRoot(source) else { throw ContentHashError.unreadableID(id) }
        sources.append((id, source))
    }

    return try sources.map { id, url in
        do {
            return ContentHashRecord(id: id, sha256: try streamSHA256(for: url))
        } catch {
            throw ContentHashError.unreadableID(id)
        }
    }
}

func runContentHashes(_ options: Options) {
    guard !options.positional.isEmpty else {
        fail("用法: photofilter content-hashes <匿名ID...> --workdir <路径>")
    }
    guard let workdir = options.flag("workdir") else { fail("缺少 --workdir") }
    guard let index = try? AnonymousIndex.read(from: workdir) else {
        fail("读不到索引，请先运行 analyze")
    }
    do {
        let records = try contentHashRecords(ids: options.positional, index: index)
        emit(records.map { ["id": $0.id, "sha256": $0.sha256] })
    } catch {
        fail(error.localizedDescription)
    }
}

// MARK: - export（只复制，绝不移动/删除/改名原图）

func runExport(_ options: Options) {
    guard let workdir = options.flag("workdir") else { fail("缺少 --workdir") }
    guard let destination = options.flag("to") else { fail("缺少 --to <目标目录>") }
    guard let index = try? AnonymousIndex.read(from: workdir) else {
        fail("读不到索引，请先运行 analyze")
    }
    let destinationURL = URL(fileURLWithPath: destination, isDirectory: true)
    let plan: [ExportCopyItem]
    do {
        plan = try ExportSafety.makePlan(
            sourceRoot: index.root,
            byAnonymous: index.byAnonymous,
            ids: options.positional,
            destination: destination
        )
        try FileManager.default.createDirectory(
            at: destinationURL, withIntermediateDirectories: true
        )
    } catch {
        fail(error.localizedDescription)
    }

    var copied: [[String: String]] = []
    for item in plan {
        do {
            // `copyItem` also fails if a file appears after preflight; it never
            // replaces that file, so a race cannot turn into an overwrite.
            try FileManager.default.copyItem(at: item.source, to: item.target)
            copied.append(["id": item.id, "filename": item.source.lastPathComponent])
        } catch {
            fail("复制失败 \(item.id)：目标未覆盖")
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
case "content-hashes": runContentHashes(options)
case "export": runExport(options)
default:
    print("""
    photofilter —— 照片筛选 agent 的本地分析进程

    analyze <目录> [--limit N] [--workdir <路径>] [--exclude-relative-json '["relative/path"]']
        递归扫描并分析：人物/风景分类、相似家族、清晰度与曝光。
        输出候选表（无路径、无文件名、时间相对化）。

    select <目录> --people N --scenery M [--limit N] [--workdir <路径>] [--exclude-relative-json '["relative/path"]']
        使用同一套排除规则完成确定性本地选片。

    preview <匿名ID> --workdir <路径> [--detail low|standard|high]
        输出无元数据 JPEG 的 base64（512 / 1024 / 1536px）。

    resolve <匿名ID...> --workdir <路径>
        本机解析匿名 ID 为真实路径（不进模型上下文）。

    content-hashes <匿名ID...> --workdir <路径>
        流式计算原图 SHA-256；只输出 id 与 sha256。

    export <匿名ID...> --workdir <路径> --to <目标目录>
        只复制到目标目录；原图不移动、不删除、不改名。
    """)
}
