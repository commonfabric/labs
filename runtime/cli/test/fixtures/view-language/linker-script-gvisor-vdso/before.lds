/*
 * Linker script for the VDSO.
 *
 * The VDSO must be carefully constructed such that the layout in the ELF file
 * is identical to the layout in memory.
 */

VDSO_PRELINK = 0xffffffffff700000;

SECTIONS {
  /* The parameter page is mapped just before the VDSO. */
  _params = VDSO_PRELINK - 0x1000;

  . = VDSO_PRELINK + SIZEOF_HEADERS;

  .hash          : { *(.hash) }             :text
  .gnu.hash      : { *(.gnu.hash) }
  .dynsym        : { *(.dynsym) }

  .eh_frame_hdr  : { *(.eh_frame_hdr) }     :text  :eh_frame_hdr
  .eh_frame      : { KEEP (*(.eh_frame)) }  :text

  . = ALIGN(0x1000);
  .text          : { *(.text*) }            :text    =0x90909090
}

PHDRS {
  text          PT_LOAD     FLAGS(5) FILEHDR PHDRS;  /* PF_R | PF_X */
  eh_frame_hdr  PT_GNU_EH_FRAME;
}

VERSION {
  LINUX_2.6 {
  global:
    clock_gettime;
    __vdso_clock_gettime;

  local: *;
  };
}
