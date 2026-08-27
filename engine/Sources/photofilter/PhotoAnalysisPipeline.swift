import CoreGraphics
import Foundation
import ImageIO

enum PhotoPathExclusionError: Error, Equatable, LocalizedError {
    case emptyOrRootPath
    case absolutePath(String)
    case parentTraversal(String)
    case nullByte(String)
    case pathEscapesRoot(String)

    var errorDescription: String? {
        switch self {
        case .emptyOrRootPath:
            return "排除路径不能为空或指向测试集根目录"
        case .absolutePath(let path):
            return "排除路径必须是相对路径: \(path)"
        case .parentTraversal(let path):
            return "排除路径不能包含 ..: \(path)"
        case .nullByte(let path):
            return "排除路径不能包含 NUL: \(path)"
        case .pathEscapesRoot(let path):
            return "排除路径解析符号链接后越出测试集: \(path)"
        }
    }
}

/// A validated, fail-closed policy for paths that must not enter a candidate set.
///
/// Both lexical and symlink-resolved prefixes are retained. Lexical matching
/// removes the requested directory itself and all descendants; resolved matching
/// also removes aliases that point back into an excluded directory. Any candidate
/// whose resolved target leaves the dataset root is skipped.
struct PhotoPathExclusions {
    let normalizedRelativePaths: [String]

    private let lexicalRoot: String
    private let resolvedRoot: String
    private let lexicalPrefixes: [String]
    private let resolvedPrefixes: [String]

    init(root: URL, excludedRelativePaths: [String]) throws {
        let standardizedRoot = root.standardizedFileURL
        lexicalRoot = standardizedRoot.path
        resolvedRoot = standardizedRoot.resolvingSymlinksInPath().standardizedFileURL.path

        var normalized: [String] = []
        var lexical: [String] = []
        var resolved: [String] = []
        var seen: Set<String> = []

        for rawPath in excludedRelativePaths {
            let components = try Self.normalizedComponents(rawPath)
            let relative = components.joined(separator: "/")
            guard seen.insert(relative).inserted else { continue }

            let lexicalURL = components.reduce(standardizedRoot) {
                $0.appendingPathComponent($1, isDirectory: false)
            }.standardizedFileURL
            guard Self.isEqualOrDescendant(lexicalURL.path, of: lexicalRoot) else {
                throw PhotoPathExclusionError.pathEscapesRoot(rawPath)
            }

            let resolvedURL = lexicalURL.resolvingSymlinksInPath().standardizedFileURL
            guard Self.isEqualOrDescendant(resolvedURL.path, of: resolvedRoot) else {
                throw PhotoPathExclusionError.pathEscapesRoot(rawPath)
            }

            normalized.append(relative)
            lexical.append(lexicalURL.path)
            resolved.append(resolvedURL.path)
        }

        normalizedRelativePaths = normalized.sorted()
        lexicalPrefixes = lexical
        resolvedPrefixes = resolved
    }

    /// `true` means the enumerated URL must never be analyzed. Resolving every
    /// candidate is intentional: a regular-file symlink can otherwise bypass an
    /// excluded directory even when directory traversal itself is disabled.
    func excludes(_ url: URL) -> Bool {
        let lexicalPath = url.standardizedFileURL.path
        guard Self.isEqualOrDescendant(lexicalPath, of: lexicalRoot) else { return true }
        if lexicalPrefixes.contains(where: {
            Self.isEqualOrDescendant(lexicalPath, of: $0)
        }) {
            return true
        }

        let resolvedPath = url.resolvingSymlinksInPath().standardizedFileURL.path
        guard Self.isEqualOrDescendant(resolvedPath, of: resolvedRoot) else { return true }
        return resolvedPrefixes.contains(where: {
            Self.isEqualOrDescendant(resolvedPath, of: $0)
        })
    }

    private static func normalizedComponents(_ rawPath: String) throws -> [String] {
        guard !rawPath.isEmpty else { throw PhotoPathExclusionError.emptyOrRootPath }
        guard !rawPath.contains("\0") else {
            throw PhotoPathExclusionError.nullByte(rawPath)
        }
        guard !(rawPath as NSString).isAbsolutePath else {
            throw PhotoPathExclusionError.absolutePath(rawPath)
        }

        let rawComponents = rawPath.split(separator: "/", omittingEmptySubsequences: false)
        guard !rawComponents.contains(where: { $0 == ".." }) else {
            throw PhotoPathExclusionError.parentTraversal(rawPath)
        }
        let normalized = rawComponents.compactMap { component -> String? in
            let value = String(component)
            return value.isEmpty || value == "." ? nil : value
        }
        guard !normalized.isEmpty else { throw PhotoPathExclusionError.emptyOrRootPath }
        return normalized
    }

    private static func isEqualOrDescendant(_ path: String, of root: String) -> Bool {
        if path == root { return true }
        if root == "/" { return path.hasPrefix("/") }
        return path.hasPrefix(root + "/")
    }
}

/// 单次解码的本地分析流水线。
///
/// 一张照片只打开一次 `CGImageSource`、只解码一次降采样图，随后的拍摄时间、感知指纹、
/// 技术质量和人物/风景分类全部复用同一份像素。原图仍然只读，像素只存在于运行内存中。
enum PhotoAnalysisPipeline {
    /// Vision 与技术分析共用的降采样边长。分类阈值全部按画面相对面积定义，在该尺度下仍然成立；
    /// 而按原始分辨率反复解码（本机 40MP JPEG 实测每张多花约 0.4 秒）没有换来判断质量。
    static let analysisPixelSize = 1024
    /// 清晰度、反差与曝光在该尺度上评估；64px 缩略图会把对焦信息一并抹掉。
    static let qualityPixelSize = 512
    /// 感知指纹固定使用 64 × 64 灰度栅格。
    static let fingerprintSideLength = 64

    static let supportedExtensions: Set<String> = [
        "jpg", "jpeg", "png", "webp", "heic", "heif", "avci", "tif", "tiff",
    ]

    nonisolated static func photoID(for url: URL) -> String {
        url.standardizedFileURL.path
    }

    /// 分析单张照片。任何一步失败都只降级该步的结果，不会抛错中断整轮扫描。
    nonisolated static func analyze(_ url: URL) -> PhotoAnalysisResult {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
            return PhotoAnalysisResult(
                photoID: photoID(for: url),
                captureDate: PhotoMetadataReader.captureDate(for: url),
                perceptualHash: nil,
                technicalQuality: nil
            )
        }

        let captureDate = PhotoMetadataReader.captureDate(from: source, url: url)
        guard let image = decodedImage(from: source, maximumPixelSize: analysisPixelSize) else {
            return PhotoAnalysisResult(
                photoID: photoID(for: url),
                captureDate: captureDate,
                perceptualHash: nil,
                technicalQuality: nil
            )
        }

        let fingerprintRaster = LuminanceThumbnailReader.raster(
            from: image,
            sideLength: fingerprintSideLength
        )
        let qualityRaster = LuminanceThumbnailReader.raster(
            from: image,
            sideLength: qualityPixelSize,
            preservingAspectRatio: true
        )

        let category = PhotoCategoryClassifier.classify(image)
        return PhotoAnalysisResult(
            photoID: photoID(for: url),
            captureDate: captureDate,
            perceptualHash: fingerprintRaster.flatMap { PerceptualHasher.hash(from: $0) },
            technicalQuality: qualityRaster.map { TechnicalQualityAnalyzer.analyze($0) },
            // 只对人物照做人脸分析：风景照上跑关键点检测是白花 CPU。
            portraitQuality: category == .people ? PortraitQualityAnalyzer.analyze(image) : nil,
            curationCategory: category
        )
    }

    nonisolated static func decodedImage(
        from source: CGImageSource,
        maximumPixelSize: Int
    ) -> CGImage? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maximumPixelSize,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    nonisolated static func decodedImage(for url: URL, maximumPixelSize: Int) -> CGImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        return decodedImage(from: source, maximumPixelSize: maximumPixelSize)
    }

    /// 并行分析一批照片，按 `batchSize` 分段回调，便于界面渐进显示。
    ///
    /// 并发路数刻意小于核心数：Vision 内部已经会用到 GPU / ANE，路数开满只会互相排队并推高内存。
    /// 每完成一张都会检查取消，因此切换或删除项目时后台工作会真的停下来。
    nonisolated static func analyze(
        urls: [URL],
        batchSize: Int,
        laneCount: Int = defaultLaneCount,
        onBatch: @Sendable @escaping ([PhotoAnalysisResult]) async -> Void
    ) async {
        guard !urls.isEmpty else { return }
        let lanes = max(1, min(laneCount, urls.count))
        var pending: [PhotoAnalysisResult] = []
        pending.reserveCapacity(batchSize)

        await withTaskGroup(of: PhotoAnalysisResult?.self) { group in
            var nextIndex = 0
            func addTask() {
                guard nextIndex < urls.count else { return }
                let url = urls[nextIndex]
                nextIndex += 1
                group.addTask {
                    guard !Task.isCancelled else { return nil }
                    return await analyzeOffCooperativePool(url)
                }
            }

            for _ in 0..<lanes { addTask() }

            while let result = await group.next() {
                if Task.isCancelled {
                    group.cancelAll()
                    return
                }
                if let result {
                    pending.append(result)
                }
                addTask()
                if pending.count >= batchSize {
                    let batch = pending
                    pending = []
                    await onBatch(batch)
                }
            }
        }

        guard !Task.isCancelled, !pending.isEmpty else { return }
        await onBatch(pending)
    }

    /// 阻塞工作专用的队列。
    ///
    /// `analyze(_:)` 内部走 Vision 的 `performRequests`，那是个会**阻塞调用线程**的
    /// 同步调用——挂死时的堆栈是
    /// `VNImageRequestHandler.performRequests → VNControlledCapacityTasksQueue
    /// .dispatchGroupWait → __ulock_wait`。
    ///
    /// 这种调用绝不能放进 Swift 并发的协作线程池：池子宽度约等于核心数，阻塞掉
    /// 几个线程，整个池子就再也调度不动。而 `defaultLaneCount` 在低核数机器上
    /// 反而会保底开 2 条（`max(2, ...)`），3 核机器上正好把池子按死——CI 就是这么
    /// 连挂三次的（6h / 3h / 30m 超时），双核 Mac 同样会中招，而且没有任何超时
    /// 能把用户救回来。
    ///
    /// 放到自己的并发队列上，Vision 再怎么阻塞，占的都是这个队列的线程；
    /// 协作池只是在 continuation 上挂起，不占线程。
    private static let analysisQueue = DispatchQueue(
        label: "com.photocurator.analysis",
        qos: .userInitiated,
        attributes: .concurrent
    )

    /// 在专用队列上完成一张照片的阻塞分析，再桥回 async。
    ///
    /// 并发度仍由调用方的 `lanes` 决定：同一时刻只有 `lanes` 个任务在等这个
    /// continuation，所以队列上也只会有 `lanes` 个线程在跑。
    private nonisolated static func analyzeOffCooperativePool(
        _ url: URL
    ) async -> PhotoAnalysisResult {
        await withCheckedContinuation { continuation in
            analysisQueue.async {
                continuation.resume(returning: analyze(url))
            }
        }
    }

    static var defaultLaneCount: Int {
        max(2, min(6, ProcessInfo.processInfo.activeProcessorCount - 2))
    }

    /// 递归收集受支持的图片；跳过隐藏文件与包内容，结果按路径自然序稳定排序。
    nonisolated static func imageURLs(
        in folder: URL,
        supportedExtensions: Set<String> = PhotoAnalysisPipeline.supportedExtensions,
        excludedRelativePaths: [String] = []
    ) throws -> [URL] {
        let exclusions = try PhotoPathExclusions(
            root: folder,
            excludedRelativePaths: excludedRelativePaths
        )
        let keys: Set<URLResourceKey> = [.isRegularFileKey, .isDirectoryKey, .isHiddenKey]
        guard let enumerator = FileManager.default.enumerator(
            at: folder,
            includingPropertiesForKeys: Array(keys),
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else {
            return []
        }

        var imageURLs: [URL] = []
        for case let url as URL in enumerator {
            let values = try? url.resourceValues(forKeys: keys)
            if exclusions.excludes(url) {
                if values?.isDirectory == true { enumerator.skipDescendants() }
                continue
            }
            guard let values,
                  values.isRegularFile == true,
                  values.isHidden != true,
                  supportedExtensions.contains(url.pathExtension.lowercased()) else {
                continue
            }
            imageURLs.append(url)
        }
        return imageURLs.sorted { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
    }
}
