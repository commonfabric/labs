// Copyright 2018 The gVisor Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#ifndef GVISOR_TEST_UTIL_FS_UTIL_H_
#define GVISOR_TEST_UTIL_FS_UTIL_H_

#include <dirent.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/types.h>
#include <unistd.h>

#include "gtest/gtest.h"
#include "absl/strings/string_view.h"
#include "test/util/file_descriptor.h"
#include "test/util/posix_error.h"

namespace gvisor {
namespace testing {

// O_LARGEFILE as defined by Linux. glibc tries to be clever by setting it to 0
// because "it isn't needed", even though Linux can return it via F_GETFL.
#if defined(__x86_64__) || defined(__riscv)
constexpr int kOLargeFile = 00100000;
#elif defined(__aarch64__)
constexpr int kOLargeFile = 00400000;
#else
#error "Unknown architecture"
#endif

// From linux/magic.h. For some reason, not defined in the headers for some
// build environments.
#define OVERLAYFS_SUPER_MAGIC 0x794c7630

// Fuchsia does not support renameat2.
#ifndef __Fuchsia__
#ifndef SYS_renameat2
#if defined(__x86_64__)
#define SYS_renameat2 316
#elif defined(__aarch64__)
#define SYS_renameat2 276
#else
#error "Unknown architecture"
#endif
#endif  // SYS_renameat2

#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1 << 0)
#endif  // RENAME_NOREPLACE

#ifndef RENAME_EXCHANGE
#define RENAME_EXCHANGE (1 <<

int renameat2(int olddirfd, const char* oldpath, int newdirfd,
              const char* newpath, unsigned int flags);
#endif  // __Fuchsia__

// Returns a status or the current working directory.
PosixErrorOr<std::string> GetCWD();

// Returns true/false depending on whether or not path exists, or an error if it
// can't be determined.
PosixErrorOr<bool> Exists(absl::string_view path);

// Returns a stat structure for the given path or an error. If the path
// represents a symlink, it will be traversed.
PosixErrorOr<struct stat> Stat(absl::string_view path);

// Returns a stat structure for the given path or an error. If the path
// represents a symlink, it will not be traversed.
PosixErrorOr<struct stat> Lstat(absl::string_view path);

}  // namespace testing
}  // namespace gvisor

#endif  // GVISOR_TEST_UTIL_FS_UTIL_H_
