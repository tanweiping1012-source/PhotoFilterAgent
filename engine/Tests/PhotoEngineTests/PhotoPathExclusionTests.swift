import Foundation
import XCTest
@testable import photofilter

final class PhotoPathExclusionTests: XCTestCase {
    private func fixture() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("photofilter-exclusions-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    private func write(_ value: String, to url: URL) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data(value.utf8).write(to: url)
    }

    func testExcludedDirectoryAndEveryDescendantAreRemovedBeforeAnalysis() throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        try write("keep", to: root.appendingPathComponent("keep.jpg"))
        try write("oracle", to: root.appendingPathComponent("oracle/direct.jpg"))
        try write("nested", to: root.appendingPathComponent("oracle/nested/hidden.jpg"))

        let urls = try PhotoAnalysisPipeline.imageURLs(
            in: root,
            excludedRelativePaths: ["oracle"]
        )

        XCTAssertEqual(urls.map(\.lastPathComponent), ["keep.jpg"])
    }

    func testNormalizationIsDeterministicAndDoesNotBroadenToRoot() throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        try write("parent", to: root.appendingPathComponent("oracle/visible.jpg"))
        try write("nested", to: root.appendingPathComponent("oracle/nested/hidden.jpg"))

        let policy = try PhotoPathExclusions(
            root: root,
            excludedRelativePaths: ["oracle//./nested/", "oracle/nested"]
        )
        XCTAssertEqual(policy.normalizedRelativePaths, ["oracle/nested"])

        let urls = try PhotoAnalysisPipeline.imageURLs(
            in: root,
            excludedRelativePaths: ["oracle//./nested/"]
        )
        XCTAssertEqual(urls.map(\.lastPathComponent), ["visible.jpg"])
    }

    func testRejectsAbsoluteTraversalEmptyAndRootPaths() throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }

        let invalid: [([String], PhotoPathExclusionError)] = [
            (["/oracle"], .absolutePath("/oracle")),
            (["../oracle"], .parentTraversal("../oracle")),
            (["oracle/../keep"], .parentTraversal("oracle/../keep")),
            ([""], .emptyOrRootPath),
            (["."], .emptyOrRootPath),
            (["./"], .emptyOrRootPath),
        ]
        for (paths, expected) in invalid {
            XCTAssertThrowsError(try PhotoPathExclusions(
                root: root,
                excludedRelativePaths: paths
            )) { error in
                XCTAssertEqual(error as? PhotoPathExclusionError, expected)
            }
        }
    }

    func testSymlinkAliasesCannotBypassAnExcludedDirectory() throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let hidden = root.appendingPathComponent("oracle/hidden.jpg")
        try write("hidden", to: hidden)
        let alias = root.appendingPathComponent("alias.jpg")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: hidden)
        try write("keep", to: root.appendingPathComponent("keep.jpg"))

        let urls = try PhotoAnalysisPipeline.imageURLs(
            in: root,
            excludedRelativePaths: ["oracle"]
        )

        XCTAssertEqual(urls.map(\.lastPathComponent), ["keep.jpg"])
    }

    func testSymlinkTargetsOutsideDatasetAreNeverCandidatesOrValidExclusions() throws {
        let root = try fixture()
        let outside = root.deletingLastPathComponent()
            .appendingPathComponent("photofilter-outside-\(UUID().uuidString).jpg")
        defer {
            try? FileManager.default.removeItem(at: root)
            try? FileManager.default.removeItem(at: outside)
        }
        try write("outside", to: outside)
        try FileManager.default.createSymbolicLink(
            at: root.appendingPathComponent("escape.jpg"),
            withDestinationURL: outside
        )
        try write("keep", to: root.appendingPathComponent("keep.jpg"))

        let urls = try PhotoAnalysisPipeline.imageURLs(in: root)
        XCTAssertEqual(urls.map(\.lastPathComponent), ["keep.jpg"])

        XCTAssertThrowsError(try PhotoPathExclusions(
            root: root,
            excludedRelativePaths: ["escape.jpg"]
        )) { error in
            XCTAssertEqual(
                error as? PhotoPathExclusionError,
                .pathEscapesRoot("escape.jpg")
            )
        }
    }
}
