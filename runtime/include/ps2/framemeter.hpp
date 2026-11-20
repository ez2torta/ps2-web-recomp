#pragma once

// Per-frame capture of the two fighters' structures for the experimental KOF XI frame meter
// (web/frame-meter.js). Off unless the page enables it. Addresses are those of the Japanese
// release (SLPS-25660); on any other game the records are marked invalid and carry zeros.
//
// The page reads the ring through the pointer from ps2web_fm_ring(): a 64-byte header followed by
// `count` records of `record_bytes` each; record i (0-based frame number n) lives at slot n % count.
// The writer fills a record completely, then publishes it by storing `head = n + 1`.

#include <atomic>
#include <cstdint>

namespace ps2 {

inline constexpr std::uint32_t kFrameMeterMagic = 0x52544D46;  // "FMTR"
inline constexpr std::uint32_t kFrameMeterFrames = 256;
inline constexpr std::uint32_t kFrameMeterPlayerBytes = 0x600;

struct FrameMeterHeader {
    std::uint32_t magic;
    std::uint32_t record_bytes;
    std::uint32_t count;
    std::atomic<std::uint32_t> head;  // number of records published so far
    std::atomic<std::uint32_t> enabled;
    std::uint32_t reserved[11];
};
static_assert(sizeof(FrameMeterHeader) == 64);

// Record layout (byte offsets), kept in sync with web/frame-meter.js:
//   +0x00 u32 frame number   +0x04 u16 scene word   +0x06 u8 game mode   +0x07 u8 valid mask (bit s = side s)
//   +0x08 u8 point[0]   +0x09 u8 point[1]
//   +0x10 player[0] (0x600 bytes)   +0x610 player[1]   +0xC10 extra[0] (0x20)   +0xC30 extra[1]
//   +0xC50 u8 combo[0]   +0xC51 u8 combo[1]   +0xC52 u16 held pad word side 0   +0xC54 u16 held pad word side 1
// `extra` is the 0x20-byte member block of the point character (char id, HP, visible HP, stun, guard).
inline constexpr std::uint32_t kFrameMeterRecordBytes = 0xC60;

void framemeter_enable(bool on);
void framemeter_sample(std::uint64_t frame);
const FrameMeterHeader *framemeter_ring();

}  // namespace ps2
