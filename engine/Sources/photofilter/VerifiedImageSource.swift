import CryptoKit
import Foundation

enum VerifiedImageSourceError: LocalizedError, Equatable {
    case invalidExpectedSHA256
    case unknownID
    case outsideAuthorizedRoot
    case unreadable
    case contentIdentityChanged

    var errorDescription: String? {
        switch self {
        case .invalidExpectedSHA256:
            "原图内容哈希格式无效，未读取任何照片。"
        case .unknownID:
            "索引中不存在该匿名照片。"
        case .outsideAuthorizedRoot:
            "照片路径已离开授权根目录，未生成任何预览。"
        case .unreadable:
            "无法读取该匿名照片，未生成任何预览。"
        case .contentIdentityChanged:
            "照片内容已在本地分析后变化，未生成任何预览。"
        }
    }
}

/// Resolve an anonymous index entry inside its frozen source root, copy the
/// original bytes into memory once, and validate those exact bytes before any
/// decoding or re-encoding can occur. A path/symlink swap therefore either
/// fails the root check or the content-identity check; unchecked bytes never
/// become model-visible pixels.
enum VerifiedImageSource {
    static func load(
        id: String,
        index: AnonymousIndex,
        expectedSHA256: String? = nil
    ) throws -> Data {
        let expected = try normalizedExpectedSHA256(expectedSHA256)
        guard let indexedPath = index.byAnonymous[id] else {
            throw VerifiedImageSourceError.unknownID
        }

        let root = URL(fileURLWithPath: index.root, isDirectory: true)
            .resolvingSymlinksInPath().standardizedFileURL
        let source = URL(fileURLWithPath: indexedPath)
            .resolvingSymlinksInPath().standardizedFileURL
        guard remainsInside(source: source, root: root) else {
            throw VerifiedImageSourceError.outsideAuthorizedRoot
        }

        let data: Data
        do {
            // Do not use mappedIfSafe: a copied Data value is the immutable
            // byte snapshot hashed below and decoded by ImageIO later.
            data = try Data(contentsOf: source)
        } catch {
            throw VerifiedImageSourceError.unreadable
        }
        if let expected, sha256(data) != expected {
            throw VerifiedImageSourceError.contentIdentityChanged
        }
        return data
    }

    static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func normalizedExpectedSHA256(_ raw: String?) throws -> String? {
        guard let raw else { return nil }
        guard raw.count == 64,
              raw == raw.lowercased(),
              raw.utf8.allSatisfy({ byte in
                  (48...57).contains(byte) || (97...102).contains(byte)
              }) else {
            throw VerifiedImageSourceError.invalidExpectedSHA256
        }
        return raw
    }

    private static func remainsInside(source: URL, root: URL) -> Bool {
        let sourcePath = source.path
        let rootPath = root.path
        if rootPath == "/" { return sourcePath.hasPrefix("/") }
        return sourcePath == rootPath || sourcePath.hasPrefix(rootPath + "/")
    }
}
