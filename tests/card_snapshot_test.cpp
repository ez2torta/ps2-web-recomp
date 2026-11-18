#include "iop/sio2.hpp"
#include "ps2/system.hpp"

#include <cstdio>
#include <fstream>
#include <initializer_list>
#include <vector>
#include <unistd.h>

static std::vector<std::uint8_t> card_command(std::initializer_list<std::uint8_t> input, std::uint32_t output_size) {
    using namespace ps2::iop::sio2;
    write(0x1f808268, 0x0c); // reset FIFO and command index
    write(0x1f808200, 2u | (static_cast<std::uint32_t>(input.size()) << 8) | (output_size << 18));
    for (const auto byte : input) write(0x1f808260, byte);
    std::vector<std::uint8_t> output;
    for (std::uint32_t i = 0; i < output_size; ++i) output.push_back(static_cast<std::uint8_t>(read(0x1f808264)));
    return output;
}

static bool select_first_page() {
    const auto reply = card_command({0x81, 0x21, 0, 0, 0, 0}, 6);
    return reply[4] == 0x2b;
}

static bool write_first_bytes() {
    if (!select_first_page()) return false;
    const auto reply = card_command({0x81, 0x42, 2, 0x33, 0x44}, 6);
    return reply[4] == 0x2b;
}

static bool first_bytes_are(std::uint8_t a, std::uint8_t b) {
    if (!select_first_page()) return false;
    const auto reply = card_command({0x81, 0x43, 2}, 8);
    return reply[3] == 0x2b && reply[4] == a && reply[5] == b && reply[6] == (a ^ b);
}

int main() {
    char path[] = "/tmp/ps2-card-test-XXXXXX";
    const int fd = mkstemp(path);
    if (fd < 0) return 1;
    close(fd);
    struct Cleanup { const char *path; ~Cleanup() { std::remove(path); } } cleanup{path};
    constexpr std::size_t size = 528u * 0x4000u;
    {
        std::vector<char> data(size, static_cast<char>(0x5a));
        std::ofstream file(path, std::ios::binary | std::ios::trunc);
        file.write(data.data(), static_cast<std::streamsize>(data.size()));
        if (!file) return 1;
    }
    int saves = 0;
    ps2::g_options.memcard_path = path;
    ps2::g_options.on_memcard_saved = [&] { ++saves; };
    ps2::iop::sio2::reset();
    ps2::CardSnapshot original;
    if (!ps2::capture_card(original) || !original.present || original.data.size() != size) return 1;
    auto invalid = original;
    invalid.data.pop_back();
    if (ps2::restore_card(invalid)) return 1;
    ps2::CardSnapshot unchanged;
    if (!ps2::capture_card(unchanged) || unchanged.data != original.data || unchanged.dirty != original.dirty) return 1;
    ps2::defer_card_flush(true);
    if (!write_first_bytes() || !first_bytes_are(0x33, 0x44)) return 1;
    for (int i = 0; i < 60; ++i) ps2::iop::sio2::flush_cards();
    auto first_byte = [&] { std::ifstream file(path, std::ios::binary); return file.get(); };
    if (first_byte() != 0x5a || saves) return 1;
    ps2::CardSnapshot observed;
    if (!ps2::capture_card(observed) || observed.data[0] != 0x33 || observed.data[1] != 0x44 || !observed.dirty || observed.quiet != 0) return 1;
    if (!ps2::restore_card(original)) return 1;
    if (!first_bytes_are(0x5a, 0x5a)) return 1;
    ps2::defer_card_flush(false);
    for (int i = 0; i < 60; ++i) ps2::iop::sio2::flush_cards();
    if (first_byte() != 0x5a || saves) return 1;
    if (!write_first_bytes()) return 1;
    for (int i = 0; i < 50; ++i) ps2::iop::sio2::flush_cards();
    if (first_byte() != 0x33 || saves != 1) return 1;
    std::puts("card snapshot, deferred flush, discard and confirm passed");
    return 0;
}
