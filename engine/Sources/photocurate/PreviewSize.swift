import Foundation

/// 发给视觉模型的预览尺寸档位（最长边像素）。
///
/// 原图永远不出本机：任何一档都是重新编码、剥掉全部元数据的 JPEG。
/// 三档存在的意义是让 agent 按需花钱——容易判断的照片用 `low` 扫一眼，
/// 只有真正卡在切线上的才值得 `high`。
public enum AIReviewPreviewSize: String, Codable, CaseIterable, Sendable {
    case small
    case medium
    case large

    /// 别名：agent 侧用 low/standard/high 表达“花多少钱看这一张”。
    public init?(detail: String) {
        switch detail.lowercased() {
        case "low", "small": self = .small
        case "standard", "medium": self = .medium
        case "high", "large": self = .large
        default: return nil
        }
    }

    public var maximumPixelSize: Int {
        switch self {
        case .small: 512
        case .medium: 1_024
        case .large: 1_536
        }
    }

    public var detailName: String {
        switch self {
        case .small: "low"
        case .medium: "standard"
        case .large: "high"
        }
    }
}
