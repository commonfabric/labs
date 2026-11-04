# Copyright 2018 The gVisor Authors.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.

"""Verify VDSO ELF does not contain any relocations and is directly mmappable.
"""

import logging
import subprocess

PAGE_SIZE = 4096


def PageRoundDown(addr):
  """Rounds down to the nearest page.

  Args:
    addr: An address.

  Returns:
    The address rounded down to the nearest page.
  """
  return addr & ~(PAGE_SIZE - 1)


def Fatal(*args, **kwargs):
  """Logs a critical message and exits with code 1."""
  logging.critical(*args, **kwargs)
  exit(1)


def CheckSegments(vdso_path):
  """Verifies layout of PT_LOAD segments."""
  output = subprocess.check_output(["readelf", "-lW", vdso_path]).decode()
  segments = []
  for line in output.split("\n"):
    if not line.startswith("  LOAD"):
      continue
    components = line.split()
    segments.append({
        "offset": int(components[1], 16),
        "addr": int(components[2], 16),
        "filesz": int(components[4], 16),
    })
  if not segments:
    Fatal("No PT_LOAD segments in VDSO")
  return segments
