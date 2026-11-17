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
  if (thread_state == THREAD_STATE_INITIALIZING) {
    // This thread was interrupted before it even had a context.
    return;
  }

  struct thread_context *ctx = sysmsg->context;

  // If the current thread is in syshandler, an interrupt has to be postponed,
  // because sysmsg can't be changed.
  if (signo == SIGCHLD && thread_state != THREAD_STATE_NONE) {
    return;
  }

  long fs_base = get_fsbase();

  ctx->signo = signo;
  ctx->siginfo = *siginfo;

  enum context_state ctx_state = CONTEXT_STATE_INVALID;

  atomic_store(&ctx->fpstate_changed, 0);
  ctx = switch_context_amd64(sysmsg, ctx, ctx_state);
  if (fs_base != ctx->ptregs.fs_base) {
    set_fsbase(ctx->ptregs.fs_base);
  }
  ptregs_to_gregs(ucontext, &ctx->ptregs);
}

void __export_start(struct sysmsg *sysmsg, void *_ucontext) {
  init_new_thread();

  asm volatile("movq %%gs:0, %0\n" : "=r"(sysmsg) : :);
  if (sysmsg->self != sysmsg) {
    panic(STUB_ERROR_BAD_SYSMSG, 0);
  }

  struct thread_context *ctx =
      switch_context_amd64(sysmsg, NULL, CONTEXT_STATE_INVALID);

  restore_state(sysmsg, ctx, _ucontext);
}

// asm_restore_state is implemented in syshandler_amd64.S
void asm_restore_state();
