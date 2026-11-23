// Copyright 2023 The gVisor Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

#include <cuda_runtime.h>
#include <err.h>

#include <cstdint>
#include <iostream>

#include "cuda_test_util.h"  // NOLINT(build/include)

__global__ void addKernel(std::uint32_t* data) {
  size_t index = blockIdx.x * blockDim.x + threadIdx.x;
  data[index] += static_cast<std::uint32_t>(index);
}

void TestMallocHostReadWrite(int device) {
  constexpr size_t kNumBlocks = 32;
  constexpr size_t kNumThreads = 64;
  constexpr size_t kNumElems = kNumBlocks * kNumThreads;

  constexpr size_t kNumBytes = kNumElems * sizeof(std::uint32_t);
  std::uint32_t* cpu_data = nullptr;
  CHECK_CUDA(cudaMallocHost(&cpu_data, kNumBytes, cudaHostAllocWriteCombined));
  std::uint32_t* gpu_data = nullptr;
  CHECK_CUDA(cudaMalloc(&gpu_data, kNumBytes));

  // Copy the array to the device, mutate it there, and copy it back.
  CHECK_CUDA(cudaMemcpy(gpu_data, cpu_data, kNumBytes, cudaMemcpyHostToDevice));
  addKernel<<<kNumBlocks, kNumThreads>>>(gpu_data);
  CHECK_CUDA(cudaGetLast
  CHECK_CUDA(cudaDeviceSynchronize());
  CHECK_CUDA(cudaMemcpy(cpu_data, gpu_data, kNumBytes, cudaMemcpyDeviceToHost));

  // Check that the array has the expected result.
  for (size_t i = 0; i < kNumElems; i++) {
    if (cpu_data[i] != static_cast<std::uint32_t>(i)) {
      std::cout << "cpu_data[" << i << "]: got " << cpu_data[i] << std::endl;
      abort();
    }
  }
}
