import Foundation

struct ExportCopyItem: Equatable {
    let id: String
    let source: URL
    let target: URL
}

enum ExportSafetyError: LocalizedError, Equatable {
    case destinationInsideSourceRoot
    case unknownPhotoID(String)
    case sourceOutsideRoot(String)
    case duplicateDestinationName(String)
    case destinationAlreadyExists(String)

    var errorDescription: String? {
        switch self {
        case .destinationInsideSourceRoot:
            "导出目录不能等于或位于原图目录内部"
        case let .unknownPhotoID(id):
            "未知的照片 ID：\(id)"
        case let .sourceOutsideRoot(id):
            "照片 \(id) 的本地索引超出已分析的源目录"
        case let .duplicateDestinationName(id):
            "照片 \(id) 与另一张入选照片导出后会重名；为避免覆盖已拒绝导出"
        case let .destinationAlreadyExists(id):
            "照片 \(id) 的目标文件已存在；默认不覆盖，请改用空目录"
        }
    }
}

enum ExportSafety {
    private static func canonicalURL(_ path: String, isDirectory: Bool) -> URL {
        URL(fileURLWithPath: path, isDirectory: isDirectory)
            .standardizedFileURL
            .resolvingSymlinksInPath()
    }

    private static func isSameOrDescendant(_ candidate: URL, of root: URL) -> Bool {
        let rootComponents = root.pathComponents
        let candidateComponents = candidate.pathComponents
        guard candidateComponents.count >= rootComponents.count else { return false }
        return Array(candidateComponents.prefix(rootComponents.count)) == rootComponents
    }

    /// Build the complete copy plan before writing anything. This makes a
    /// pre-existing target or duplicate basename a fail-closed, zero-write
    /// outcome instead of a partial export followed by an overwrite.
    static func makePlan(
        sourceRoot: String,
        byAnonymous: [String: String],
        ids: [String],
        destination: String,
        fileExists: (String) -> Bool = FileManager.default.fileExists(atPath:)
    ) throws -> [ExportCopyItem] {
        let root = canonicalURL(sourceRoot, isDirectory: true)
        let destinationURL = canonicalURL(destination, isDirectory: true)
        guard !isSameOrDescendant(destinationURL, of: root) else {
            throw ExportSafetyError.destinationInsideSourceRoot
        }

        var targetPaths = Set<String>()
        var plan: [ExportCopyItem] = []
        plan.reserveCapacity(ids.count)
        for id in ids {
            guard let path = byAnonymous[id] else {
                throw ExportSafetyError.unknownPhotoID(id)
            }
            let source = canonicalURL(path, isDirectory: false)
            guard isSameOrDescendant(source, of: root), source.path != root.path else {
                throw ExportSafetyError.sourceOutsideRoot(id)
            }
            let target = destinationURL.appendingPathComponent(source.lastPathComponent)
                .standardizedFileURL
            guard targetPaths.insert(target.path).inserted else {
                throw ExportSafetyError.duplicateDestinationName(id)
            }
            guard !fileExists(target.path) else {
                throw ExportSafetyError.destinationAlreadyExists(id)
            }
            plan.append(ExportCopyItem(id: id, source: source, target: target))
        }
        return plan
    }
}
