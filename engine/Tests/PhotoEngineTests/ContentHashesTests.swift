import Foundation
import XCTest
@testable import photofilter

final class ContentHashesTests: XCTestCase {
    private func fixture() throws -> (root: URL, workdir: URL) {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("photofilter-content-hash-\(UUID().uuidString)", isDirectory: true)
        let workdir = root.appendingPathComponent("work", isDirectory: true)
        try FileManager.default.createDirectory(at: workdir, withIntermediateDirectories: true)
        return (root, workdir)
    }

    func testStreamsSyntheticOriginalsAndReturnsOnlyAnonymousIdentityAndSHA256() throws {
        let value = try fixture()
        defer { try? FileManager.default.removeItem(at: value.root) }
        let first = value.root.appendingPathComponent("private-original-name.jpg")
        let second = value.root.appendingPathComponent("another-private-name.jpg")
        try Data("abc".utf8).write(to: first)
        try Data().write(to: second)
        let index = AnonymousIndex(
            root: value.root.path,
            byAnonymous: ["p002": second.path, "p001": first.path]
        )

        let records = try contentHashRecords(ids: ["p001", "p002"], index: index)

        XCTAssertEqual(records, [
            ContentHashRecord(
                id: "p001",
                sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
            ),
            ContentHashRecord(
                id: "p002",
                sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            ),
        ])
        XCTAssertFalse(records.description.contains("private-original-name"))
    }

    func testDuplicateAndUnknownIDsFailClosed() throws {
        let value = try fixture()
        defer { try? FileManager.default.removeItem(at: value.root) }
        let source = value.root.appendingPathComponent("source.jpg")
        try Data("source".utf8).write(to: source)
        let index = AnonymousIndex(root: value.root.path, byAnonymous: ["p001": source.path])

        XCTAssertThrowsError(try contentHashRecords(
            ids: ["p001", "p001"],
            index: index
        )) { error in
            XCTAssertEqual(error as? ContentHashError, .duplicateID("p001"))
        }
        XCTAssertThrowsError(try contentHashRecords(
            ids: ["p001", "p999"],
            index: index
        )) { error in
            XCTAssertEqual(error as? ContentHashError, .unknownID("p999"))
        }
    }

    func testUnreadableIndexedSourceFailsWithoutLeakingItsPath() throws {
        let value = try fixture()
        defer { try? FileManager.default.removeItem(at: value.root) }
        let missing = value.root.appendingPathComponent("secret-missing.jpg")
        let index = AnonymousIndex(root: value.root.path, byAnonymous: ["p001": missing.path])

        XCTAssertThrowsError(try contentHashRecords(ids: ["p001"], index: index)) { error in
            XCTAssertEqual(error as? ContentHashError, .unreadableID("p001"))
            XCTAssertFalse(error.localizedDescription.contains("secret-missing"))
        }
    }

    func testSymlinkSwapCannotHashAFileOutsideTheIndexedSourceRoot() throws {
        let value = try fixture()
        let outside = value.root.deletingLastPathComponent()
            .appendingPathComponent("photofilter-hash-outside-\(UUID().uuidString).jpg")
        defer {
            try? FileManager.default.removeItem(at: value.root)
            try? FileManager.default.removeItem(at: outside)
        }
        try Data("outside-secret".utf8).write(to: outside)
        let swapped = value.root.appendingPathComponent("selected.jpg")
        try FileManager.default.createSymbolicLink(at: swapped, withDestinationURL: outside)
        let index = AnonymousIndex(root: value.root.path, byAnonymous: ["p001": swapped.path])

        XCTAssertThrowsError(try contentHashRecords(ids: ["p001"], index: index)) { error in
            XCTAssertEqual(error as? ContentHashError, .unreadableID("p001"))
            XCTAssertFalse(error.localizedDescription.contains(outside.lastPathComponent))
        }
    }
}
