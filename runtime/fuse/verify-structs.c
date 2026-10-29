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
    printf("stat_st_nlink_bytes=%zu\n", sizeof(((struct stat *)0)->st_nlink));
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

    // fuse_file_info
    printf("file_info_size=%zu\n", sizeof(struct fuse_file_info));
    printf("file_info_flags=%zu\n", offsetof(struct fuse_file_info, flags));
    printf("file_info_fh=%zu\n", offsetof(struct fuse_file_info, fh));

    // fuse_args
    printf("fuse_args_size=%zu\n", sizeof(struct fuse_args));

    // fuse_lowlevel_ops — sizes and key offsets
    printf("ops_size=%zu\n", sizeof(struct fuse_lowlevel_ops));
    printf("ops_init=%zu\n", offsetof(struct fuse_lowlevel_ops, init));
    printf("ops_destroy=%zu\n", offsetof(struct fuse_lowlevel_ops, destroy));
    printf("ops_lookup=%zu\n", offsetof(struct fuse_lowlevel_ops, lookup));
    printf("ops_forget=%zu\n", offsetof(struct fuse_lowlevel_ops, forget));
    printf("ops_getattr=%zu\n", offsetof(struct fuse_lowlevel_ops, getattr));
    printf("ops_setattr=%zu\n", offsetof(struct fuse_lowlevel_ops, setattr));
    printf("ops_readlink=%zu\n", offsetof(struct fuse_lowlevel_ops, readlink));
    printf("ops_mknod=%zu\n", offsetof(struct fuse_lowlevel_ops, mknod));
    printf("ops_mkdir=%zu\n", offsetof(struct fuse_lowlevel_ops, mkdir));
    printf("ops_unlink=%zu\n", offsetof(struct fuse_lowlevel_ops, unlink));
    printf("ops_rmdir=%zu\n", offsetof(struct fuse_lowlevel_ops, rmdir));
    printf("ops_symlink=%zu\n", offsetof(struct fuse_lowlevel_ops, symlink));
    printf("ops_rename=%zu\n", offsetof(struct fuse_lowlevel_ops, rename));
    printf("ops_link=%zu\n", offsetof(struct fuse_lowlevel_ops, link));
    printf("ops_open=%zu\n", offsetof(struct fuse_lowlevel_ops, open));
    printf("ops_read=%zu\n", offsetof(struct fuse_lowlevel_ops, read));
    printf("ops_write=%zu\n", offsetof(struct fuse_lowlevel_ops, write));
    printf("ops_flush=%zu\n", offsetof(struct fuse_lowlevel_ops, flush));
    printf("ops_release=%zu\n", offsetof(struct fuse_lowlevel_ops, release));
    printf("ops_fsync=%zu\n", offsetof(struct fuse_lowlevel_ops, fsync));
    printf("ops_opendir=%zu\n", offsetof(struct fuse_lowlevel_ops, opendir));
    printf("ops_readdir=%zu\n", offsetof(struct fuse_lowlevel_ops, readdir));
    printf("ops_releasedir=%zu\n", offsetof(struct fuse_lowlevel_ops, releasedir));
    printf("ops_fsyncdir=%zu\n", offsetof(struct fuse_lowlevel_ops, fsyncdir));
    printf("ops_statfs=%zu\n", offsetof(struct fuse_lowlevel_ops, statfs));
    printf("ops_setxattr=%zu\n", offsetof(struct fuse_lowlevel_ops, setxattr));
    printf("ops_getxattr=%zu\n", offsetof(struct fuse_lowlevel_ops, getxattr));
    printf("ops_listxattr=%zu\n", offsetof(struct fuse_lowlevel_ops, listxattr));
    printf("ops_removexattr=%zu\n", offsetof(struct fuse_lowlevel_ops, removexattr));
    printf("ops_access=%zu\n", offsetof(struct fuse_lowlevel_ops, access));
    printf("ops_create=%zu\n", offsetof(struct fuse_lowlevel_ops, create));

    return 0;
}
