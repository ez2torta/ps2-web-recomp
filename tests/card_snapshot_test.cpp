#include "iop/sio2.hpp"
#include "ps2/system.hpp"

#include <cstdio>
#include <fstream>
#include <vector>
#include <unistd.h>

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
    auto changed = original;
    changed.data[0] = 0x33;
    changed.dirty = true;
    changed.quiet = 49;
    auto invalid = changed;
    invalid.data.pop_back();
    if (ps2::restore_card(invalid)) return 1;
    ps2::CardSnapshot unchanged;
    if (!ps2::capture_card(unchanged) || unchanged.data != original.data || unchanged.dirty != original.dirty) return 1;
    ps2::defer_card_flush(true);
    if (!ps2::restore_card(changed)) return 1;
    for (int i = 0; i < 60; ++i) ps2::iop::sio2::flush_cards();
    auto first_byte = [&] { std::ifstream file(path, std::ios::binary); return file.get(); };
    if (first_byte() != 0x5a || saves) return 1;
    ps2::CardSnapshot observed;
    if (!ps2::capture_card(observed) || observed.data[0] != 0x33 || !observed.dirty || observed.quiet != 49) return 1;
    if (!ps2::restore_card(original)) return 1;
    ps2::defer_card_flush(false);
    for (int i = 0; i < 60; ++i) ps2::iop::sio2::flush_cards();
    if (first_byte() != 0x5a || saves) return 1;
    if (!ps2::restore_card(changed)) return 1;
    ps2::iop::sio2::flush_cards();
    if (first_byte() != 0x33 || saves != 1) return 1;
    std::puts("card snapshot, deferred flush, discard and confirm passed");
    return 0;
}
