// Copyright 2018 The gVisor Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

#include "textflag.h"

// Documentation is available in parameters.go.
//
// func muldiv64(value, multiplier, divisor uint64) (uint64, bool)
TEXT ·muldiv64(SB),NOSPLIT|NOFRAME,$0-33
  MOVQ value+0(FP), AX
  MOVQ multiplier+8(FP), BX
  MOVQ divisor+16(FP), CX

  // Multiply AX*BX and store result in DX:AX.
  MULQ BX
  CMPQ CX, /* the divisor