// Copyright 2020 The gVisor Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

#define _GNU_SOURCE
#include <signal.h>
#include <stdint.h>

#include "sysmsg.h"

#ifndef X86_TRAP_PF
#define X86_TRAP_PF 14
#endif

void __export_sighandler(int signo, siginfo_t *siginfo, void *_ucontext) {
  ucontext_t *ucontext = _ucontext;
  void *sp = sysmsg_sp();
  struct sysmsg *sysmsg = sysmsg_addr(sp);

  if (sysmsg != sysmsg->self) panic(STUB_ERROR_BAD_SYSMSG, 0);
  int32_t thread_state = atomic_load(&sysmsg->state);
  struct thread_context *ctx = NULL;
  enum context_state ctx_state = CONTEXT_STATE_INVALID;
  long fs_base = 0;

  if (thread_state == THREAD_STATE_INITIALIZING) {
    // Find a new context and exit to restore it.
    init_new_thread();
    goto in

  ctx = sysmsg->context;

  // If the current thread is in syshandler, an interrupt has to be postponed,
  // because sysmsg can't be changed.
  if (signo == SIGCHLD && thread_state != THREAD_STATE_NONE) {
    return;
  }

  fs_base = get_fsbase();

  ctx->signo = signo;
  ctx->siginfo = *siginfo;

  atomic_store(&ctx->fpstate_changed, 0);

init:
  ctx = switch_context_amd64(sysmsg, ctx, ctx_state);
  if (fs_base != ctx->ptregs.fs_base) {
    set_fsbase(ctx->ptregs.fs_base);
  }
  ptregs_to_gregs(ucontext, &ctx->ptregs);
}

// asm_restore_state is implemented in syshandler_amd64.S
void asm_restore_state();
