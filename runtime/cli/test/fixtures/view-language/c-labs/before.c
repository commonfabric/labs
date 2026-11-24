// verify-structs.c — Print struct offsets and sizes for FUSE FFI verification.
// Compile: gcc -o verify-structs verify-structs.c $(pkg-config --cflags fuse3)
// Run: ./verify-structs
//
// Output is key=value pairs consumed by verify-structs.test.ts to validate
// that the hardcoded offsets in platform-linux.ts match the actual C layouts.

#include <stddef.h>
#include <stdio.h>
#include <sys/stat.h>

#define FUSE_USE_VERSION 35
#include <fuse3/fuse_lowlevel.h>

int main(void) {
    // struct stat
    printf("stat_size=%zu\n", sizeof(struct stat));
    printf("stat_st_dev=%zu\n", offsetof(struct stat, st_dev));
    printf("stat_st_ino=%zu\n", offsetof(struct stat, st_ino));
    printf("stat_st_nlink=%zu\n", offsetof(struct stat, st_nlink));
    printf("stat_st_mode=%zu\n", offsetof(struct stat, st_mode));
    printf("stat_st_uid=%zu\n", offsetof(struct stat, st_uid));
    printf("stat_st_gid=%zu\n", offsetof(struct stat, st_gid));
    printf("stat_st_size=%zu\n", offsetof(struct stat, st_size));
    printf("stat_st_mtim=%zu\n", offsetof(struct stat, st_mtim));

    // fuse_entry_param
    printf("entry_param_size=%zu\n", sizeof(struct fuse_entry_param));
    printf("entry_param_ino=%zu\n", offsetof(struct fuse_entry_param, ino));
    printf("entry_param_generation=%zu\n", offsetof(struct fuse_entry_param, generation));
    printf("entry_param_attr=%zu\n", offsetof(struct fuse_entry_param, attr));
    printf("entry_param_attr_timeout=%zu\n", offsetof(struct fuse_entry_param, attr_timeout));
    printf("entry_param_entry_timeout=%zu\n", offsetof(struct fuse_entry_param, entry_timeout));

    return 0;
}
