import Foundation

/// 确定性选片：不联网、不花钱、结果可复现。
///
/// 它有两个身份。没有 API Key 时它就是产品本身；有 Key 时它是 agent 的**兜底**——
/// agent 跑飞、超时、提议不合法，都回落到这里。因此它必须永远能给出一个合理答案，
/// 而不是报错。
///
/// 规则和 agent 的策略同构，只是把"看图判断"换成了本地技术指标：
///   1. 同一相似家族只出一个代表（保住这个瞬间，不重复占名额）
///   2. 家族冠军按本地技术优先级选
///   3. 冠军之间按综合分排序，取前 N
enum LocalSelection {
    /// 一个指标在同类照片里的分位（0–1）。
    ///
    /// 用分位而不是绝对值，是因为这些指标的绝对刻度没有跨目录的意义：
    /// 阴天海边全部照片的动态范围都在 85–100 之间，用绝对值算，人人都是满分；
    /// 而我们真正要回答的问题从来是"这一张在这一批里排第几"。
    private static func percentiles(_ values: [Double]) -> [Double] {
        guard values.count > 1 else { return values.map { _ in 0.5 } }
        let sorted = values.sorted()
        return values.map { value in
            // 同分取中点，保证并列不会人为拉开差距。
            var low = 0
            var high = sorted.count
            while low < high {
                let mid = (low + high) / 2
                if sorted[mid] < value { low = mid + 1 } else { high = mid }
            }
            var upper = low
            while upper < sorted.count, sorted[upper] == value { upper += 1 }
            let rank = Double(low + upper) / 2
            return rank / Double(sorted.count)
        }
    }

    struct Outcome {
        let keep: [String]
        let familyChampions: [String: String]
        let scores: [String: Int]
    }

    /// 在给定类型里选出 `target` 张。
    static func select(
        photos: [PhotoItem],
        families: CandidateFamilyIndex,
        category: PhotoCurationCategory,
        target: Int
    ) -> Outcome {
        let pool = photos.filter { $0.curationCategory == category }
        guard !pool.isEmpty, target > 0 else {
            return Outcome(keep: [], familyChampions: [:], scores: [:])
        }

        let sharpness = pool.map { $0.technicalQuality?.sharpness ?? 0 }
        let range = pool.map { Double($0.technicalQuality?.dynamicRange ?? 0) }
        // 过曝/欠曝越少越好，取负值让"大分位"始终代表"更好"。
        let cleanliness = pool.map { photo -> Double in
            guard let quality = photo.technicalQuality else { return -1 }
            return -(quality.shadowClippingRatio + quality.highlightClippingRatio)
        }

        let sharpRank = percentiles(sharpness)
        let rangeRank = percentiles(range)
        let cleanRank = percentiles(cleanliness)

        var scores: [String: Int] = [:]
        for (offset, photo) in pool.enumerated() {
            // 清晰度权重最高：它是唯一一个"低了就没救"的维度——构图和光线见仁见智，
            // 糊了就是废片。
            var value = sharpRank[offset] * 55 + rangeRank[offset] * 25 + cleanRank[offset] * 20

            // 风险不是扣一点分的事：严重虚焦或严重过曝不该进最终名单，
            // 除非同一场景没有别的选择——那由家族逻辑决定，不在这里。
            for risk in photo.technicalQuality?.risks ?? [] {
                switch risk {
                case .lowSharpness: value -= 30
                case .heavyHighlightClipping, .heavyShadowClipping: value -= 20
                case .lowContrast: value -= 10
                }
            }
            if photo.localRecommendations.contains(where: \.isTopCandidate) { value += 5 }
            scores[photo.id] = max(0, min(100, Int(value.rounded())))
        }

        // 家族内定冠军。打平时用照片 ID 决胜，保证同一目录每次跑出同样的结果。
        var championByFamily: [String: String] = [:]
        var standalone: [PhotoItem] = []
        for photo in pool {
            guard let familyID = families.familyID(for: photo.id) else {
                standalone.append(photo)
                continue
            }
            guard let current = championByFamily[familyID] else {
                championByFamily[familyID] = photo.id
                continue
            }
            let challenger = scores[photo.id] ?? 0
            let incumbent = scores[current] ?? 0
            if challenger > incumbent
                || (challenger == incumbent
                    && photo.id.localizedStandardCompare(current) == .orderedAscending) {
                championByFamily[familyID] = photo.id
            }
        }

        let championIDs = Set(championByFamily.values)
        let contenders = pool.filter { championIDs.contains($0.id) } + standalone
        let ranked = contenders.sorted { lhs, rhs in
            let left = scores[lhs.id] ?? 0
            let right = scores[rhs.id] ?? 0
            if left != right { return left > right }
            return lhs.id.localizedStandardCompare(rhs.id) == .orderedAscending
        }

        return Outcome(
            keep: ranked.prefix(target).map(\.id),
            familyChampions: championByFamily,
            scores: scores
        )
    }
}
