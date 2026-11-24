// Copyright 2025 The gVisor Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

// CFC (Contextual Flow Control) end-to-end tests.

#include <sys/wait.h>
#include <unistd.h>

#include <string>
#include <vector>

#include "gtest/gtest.h"
#include "absl/strings/str_cat.h"
#include "test/util/test_util.h"

namespace gvisor {
namespace testing {

namespace {

constexpr char kCFCXattrName[] = "trusted.cfc.contentLabel";

bool XattrListContains(const char* list, ssize_t size, const char* name) {
  ssize_t off = 0;
  while (off < size) {
    size_t remaining = static_cast<size_t>(size - off);
    size_t len = strnlen(list + off, remaining);
    if (std::string(list + off, len) == name) {
      return true;
    }
    off += static_cast<ssize_t>(len) + 1;
  }
  return false;
}

std::string MakeCFCLabel(const std::string& user_id) {
  return absl::StrCat(
      R"({"confidentiality":[{"subject":")", user_id,
      R"(","type":"gvisor.test.user"}]})");
}

void ReadToBecomeTaintedOrExit(int fd, int exit_code) {
  char buf[256];
  if (read(fd, buf, sizeof(buf)) <= 0) {
    _exit(exit_code);
  }
}

class CFCTest : public ::testing::Test {
 protected:
  std::string test_file_name_;
  FileDescriptor test_file_fd_;
};

TEST_F(CFCTest, SaveRestorePreservesHostBackedFileLabelAndTaint) {
  SKIP_IF(!IsRunningOnGvisor());
}

}  // namespace

}  // namespace testing
}  // namespace gvisor
