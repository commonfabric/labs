/* Copyright 2020 The gVisor Authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 */

SECTIONS
{
        .crblob 0x0 : {
                *(.head.text)
                *(.text*)
                . = ALIGN(32);
                *(.data*)
                . = ALIGN(32);
                *(.bss*)
        } =0x00000000,

        /DISCARD/ : {
                *(.interp) *(.gnu.hash) *(.hash) *(.dynamic) *(.eh_frame)
        }
}
