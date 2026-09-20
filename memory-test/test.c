#include <stdlib.h>
#include <unistd.h>
#include <stdint.h>

int main(void) {
    size_t size = 4ULL * 1024 * 1024 * 1024;
    uint8_t *x = calloc(1, size);
    if (!x) return 1;

    while (1) {
        for (size_t i = 0; i < size; i += 4096)
            x[i]++;
        usleep(100000);
    }
}
