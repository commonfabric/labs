VDSO_PRELINK = 0xffffffffff700000;

SECTIONS {
  _params = VDSO_PRELINK - 0x1000;

  .gnu.hash      : { *(.gnu.hash) }
  .dynamic       : { *(.dynamic
  /* The text section follows the
