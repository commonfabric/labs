import { css } from "lit";

export const layoutSpacingUtilityStyles = css`
  /*
  * Layout utility props map to the shared --cf-spacing-* namespace.
  * Numeric values keep the existing 0/1/2/.../24 contract.
  * T-shirt aliases are shared aliases within the same spacing namespace.
  */

  /* Gap utilities */
  .gap-0 {
    gap: var(--cf-spacing-0, 0);
  }
  .gap-1 {
    gap: var(--cf-spacing-1, 0.25rem);
  }
  .gap-2 {
    gap: var(--cf-spacing-2, 0.5rem);
  }
  .gap-3 {
    gap: var(--cf-spacing-3, 0.75rem);
  }
  .gap-4 {
    gap: var(--cf-spacing-4, 1rem);
  }
  .gap-5 {
    gap: var(--cf-spacing-5, 1.25rem);
  }
  .gap-6 {
    gap: var(--cf-spacing-6, 1.5rem);
  }
  .gap-8 {
    gap: var(--cf-spacing-8, 2rem);
  }
  .gap-10 {
    gap: var(--cf-spacing-10, 2.5rem);
  }
  .gap-12 {
    gap: var(--cf-spacing-12, 3rem);
  }
  .gap-16 {
    gap: var(--cf-spacing-16, 4rem);
  }
  .gap-20 {
    gap: var(--cf-spacing-20, 5rem);
  }
  .gap-24 {
    gap: var(--cf-spacing-24, 6rem);
  }
  .gap-xs {
    gap: var(--cf-spacing-xs, 0.125rem);
  }
  .gap-sm {
    gap: var(--cf-spacing-sm, 0.25rem);
  }
  .gap-md {
    gap: var(--cf-spacing-md, 0.5rem);
  }
  .gap-lg {
    gap: var(--cf-spacing-lg, 0.75rem);
  }
  .gap-xl {
    gap: var(--cf-spacing-xl, 1rem);
  }

  /* Row gap utilities */
  .row-gap-0 {
    row-gap: var(--cf-spacing-0, 0);
  }
  .row-gap-1 {
    row-gap: var(--cf-spacing-1, 0.25rem);
  }
  .row-gap-2 {
    row-gap: var(--cf-spacing-2, 0.5rem);
  }
  .row-gap-3 {
    row-gap: var(--cf-spacing-3, 0.75rem);
  }
  .row-gap-4 {
    row-gap: var(--cf-spacing-4, 1rem);
  }
  .row-gap-5 {
    row-gap: var(--cf-spacing-5, 1.25rem);
  }
  .row-gap-6 {
    row-gap: var(--cf-spacing-6, 1.5rem);
  }
  .row-gap-8 {
    row-gap: var(--cf-spacing-8, 2rem);
  }
  .row-gap-10 {
    row-gap: var(--cf-spacing-10, 2.5rem);
  }
  .row-gap-12 {
    row-gap: var(--cf-spacing-12, 3rem);
  }
  .row-gap-16 {
    row-gap: var(--cf-spacing-16, 4rem);
  }
  .row-gap-20 {
    row-gap: var(--cf-spacing-20, 5rem);
  }
  .row-gap-24 {
    row-gap: var(--cf-spacing-24, 6rem);
  }

  /* Column gap utilities */
  .col-gap-0 {
    column-gap: var(--cf-spacing-0, 0);
  }
  .col-gap-1 {
    column-gap: var(--cf-spacing-1, 0.25rem);
  }
  .col-gap-2 {
    column-gap: var(--cf-spacing-2, 0.5rem);
  }
  .col-gap-3 {
    column-gap: var(--cf-spacing-3, 0.75rem);
  }
  .col-gap-4 {
    column-gap: var(--cf-spacing-4, 1rem);
  }
  .col-gap-5 {
    column-gap: var(--cf-spacing-5, 1.25rem);
  }
  .col-gap-6 {
    column-gap: var(--cf-spacing-6, 1.5rem);
  }
  .col-gap-8 {
    column-gap: var(--cf-spacing-8, 2rem);
  }
  .col-gap-10 {
    column-gap: var(--cf-spacing-10, 2.5rem);
  }
  .col-gap-12 {
    column-gap: var(--cf-spacing-12, 3rem);
  }
  .col-gap-16 {
    column-gap: var(--cf-spacing-16, 4rem);
  }
  .col-gap-20 {
    column-gap: var(--cf-spacing-20, 5rem);
  }
  .col-gap-24 {
    column-gap: var(--cf-spacing-24, 6rem);
  }

  /* Padding utilities */
  .p-0 {
    padding: var(--cf-spacing-0, 0);
  }
  .p-1 {
    padding: var(--cf-spacing-1, 0.25rem);
  }
  .p-2 {
    padding: var(--cf-spacing-2, 0.5rem);
  }
  .p-3 {
    padding: var(--cf-spacing-3, 0.75rem);
  }
  .p-4 {
    padding: var(--cf-spacing-4, 1rem);
  }
  .p-5 {
    padding: var(--cf-spacing-5, 1.25rem);
  }
  .p-6 {
    padding: var(--cf-spacing-6, 1.5rem);
  }
  .p-8 {
    padding: var(--cf-spacing-8, 2rem);
  }
  .p-10 {
    padding: var(--cf-spacing-10, 2.5rem);
  }
  .p-12 {
    padding: var(--cf-spacing-12, 3rem);
  }
  .p-16 {
    padding: var(--cf-spacing-16, 4rem);
  }
  .p-20 {
    padding: var(--cf-spacing-20, 5rem);
  }
  .p-24 {
    padding: var(--cf-spacing-24, 6rem);
  }
  .p-xs {
    padding: var(--cf-spacing-xs, 0.125rem);
  }
  .p-sm {
    padding: var(--cf-spacing-sm, 0.25rem);
  }
  .p-md {
    padding: var(--cf-spacing-md, 0.5rem);
  }
  .p-lg {
    padding: var(--cf-spacing-lg, 0.75rem);
  }
  .p-xl {
    padding: var(--cf-spacing-xl, 1rem);
  }

  /*
  * Directional padding utilities. Declared after the uniform .p-* utilities
  * (and the px and py axes before single sides) so that, at equal
  * specificity, a directional value overrides the uniform padding on its
  * side.
  */

  /* Horizontal padding utilities */
  .px-0 {
    padding-left: var(--cf-spacing-0, 0);
    padding-right: var(--cf-spacing-0, 0);
  }
  .px-1 {
    padding-left: var(--cf-spacing-1, 0.25rem);
    padding-right: var(--cf-spacing-1, 0.25rem);
  }
  .px-2 {
    padding-left: var(--cf-spacing-2, 0.5rem);
    padding-right: var(--cf-spacing-2, 0.5rem);
  }
  .px-3 {
    padding-left: var(--cf-spacing-3, 0.75rem);
    padding-right: var(--cf-spacing-3, 0.75rem);
  }
  .px-4 {
    padding-left: var(--cf-spacing-4, 1rem);
    padding-right: var(--cf-spacing-4, 1rem);
  }
  .px-5 {
    padding-left: var(--cf-spacing-5, 1.25rem);
    padding-right: var(--cf-spacing-5, 1.25rem);
  }
  .px-6 {
    padding-left: var(--cf-spacing-6, 1.5rem);
    padding-right: var(--cf-spacing-6, 1.5rem);
  }
  .px-8 {
    padding-left: var(--cf-spacing-8, 2rem);
    padding-right: var(--cf-spacing-8, 2rem);
  }
  .px-10 {
    padding-left: var(--cf-spacing-10, 2.5rem);
    padding-right: var(--cf-spacing-10, 2.5rem);
  }
  .px-12 {
    padding-left: var(--cf-spacing-12, 3rem);
    padding-right: var(--cf-spacing-12, 3rem);
  }
  .px-16 {
    padding-left: var(--cf-spacing-16, 4rem);
    padding-right: var(--cf-spacing-16, 4rem);
  }
  .px-20 {
    padding-left: var(--cf-spacing-20, 5rem);
    padding-right: var(--cf-spacing-20, 5rem);
  }
  .px-24 {
    padding-left: var(--cf-spacing-24, 6rem);
    padding-right: var(--cf-spacing-24, 6rem);
  }
  .px-xs {
    padding-left: var(--cf-spacing-xs, 0.125rem);
    padding-right: var(--cf-spacing-xs, 0.125rem);
  }
  .px-sm {
    padding-left: var(--cf-spacing-sm, 0.25rem);
    padding-right: var(--cf-spacing-sm, 0.25rem);
  }
  .px-md {
    padding-left: var(--cf-spacing-md, 0.5rem);
    padding-right: var(--cf-spacing-md, 0.5rem);
  }
  .px-lg {
    padding-left: var(--cf-spacing-lg, 0.75rem);
    padding-right: var(--cf-spacing-lg, 0.75rem);
  }
  .px-xl {
    padding-left: var(--cf-spacing-xl, 1rem);
    padding-right: var(--cf-spacing-xl, 1rem);
  }

  /* Vertical padding utilities */
  .py-0 {
    padding-top: var(--cf-spacing-0, 0);
    padding-bottom: var(--cf-spacing-0, 0);
  }
  .py-1 {
    padding-top: var(--cf-spacing-1, 0.25rem);
    padding-bottom: var(--cf-spacing-1, 0.25rem);
  }
  .py-2 {
    padding-top: var(--cf-spacing-2, 0.5rem);
    padding-bottom: var(--cf-spacing-2, 0.5rem);
  }
  .py-3 {
    padding-top: var(--cf-spacing-3, 0.75rem);
    padding-bottom: var(--cf-spacing-3, 0.75rem);
  }
  .py-4 {
    padding-top: var(--cf-spacing-4, 1rem);
    padding-bottom: var(--cf-spacing-4, 1rem);
  }
  .py-5 {
    padding-top: var(--cf-spacing-5, 1.25rem);
    padding-bottom: var(--cf-spacing-5, 1.25rem);
  }
  .py-6 {
    padding-top: var(--cf-spacing-6, 1.5rem);
    padding-bottom: var(--cf-spacing-6, 1.5rem);
  }
  .py-8 {
    padding-top: var(--cf-spacing-8, 2rem);
    padding-bottom: var(--cf-spacing-8, 2rem);
  }
  .py-10 {
    padding-top: var(--cf-spacing-10, 2.5rem);
    padding-bottom: var(--cf-spacing-10, 2.5rem);
  }
  .py-12 {
    padding-top: var(--cf-spacing-12, 3rem);
    padding-bottom: var(--cf-spacing-12, 3rem);
  }
  .py-16 {
    padding-top: var(--cf-spacing-16, 4rem);
    padding-bottom: var(--cf-spacing-16, 4rem);
  }
  .py-20 {
    padding-top: var(--cf-spacing-20, 5rem);
    padding-bottom: var(--cf-spacing-20, 5rem);
  }
  .py-24 {
    padding-top: var(--cf-spacing-24, 6rem);
    padding-bottom: var(--cf-spacing-24, 6rem);
  }
  .py-xs {
    padding-top: var(--cf-spacing-xs, 0.125rem);
    padding-bottom: var(--cf-spacing-xs, 0.125rem);
  }
  .py-sm {
    padding-top: var(--cf-spacing-sm, 0.25rem);
    padding-bottom: var(--cf-spacing-sm, 0.25rem);
  }
  .py-md {
    padding-top: var(--cf-spacing-md, 0.5rem);
    padding-bottom: var(--cf-spacing-md, 0.5rem);
  }
  .py-lg {
    padding-top: var(--cf-spacing-lg, 0.75rem);
    padding-bottom: var(--cf-spacing-lg, 0.75rem);
  }
  .py-xl {
    padding-top: var(--cf-spacing-xl, 1rem);
    padding-bottom: var(--cf-spacing-xl, 1rem);
  }

  /* Padding-top utilities */
  .pt-0 {
    padding-top: var(--cf-spacing-0, 0);
  }
  .pt-1 {
    padding-top: var(--cf-spacing-1, 0.25rem);
  }
  .pt-2 {
    padding-top: var(--cf-spacing-2, 0.5rem);
  }
  .pt-3 {
    padding-top: var(--cf-spacing-3, 0.75rem);
  }
  .pt-4 {
    padding-top: var(--cf-spacing-4, 1rem);
  }
  .pt-5 {
    padding-top: var(--cf-spacing-5, 1.25rem);
  }
  .pt-6 {
    padding-top: var(--cf-spacing-6, 1.5rem);
  }
  .pt-8 {
    padding-top: var(--cf-spacing-8, 2rem);
  }
  .pt-10 {
    padding-top: var(--cf-spacing-10, 2.5rem);
  }
  .pt-12 {
    padding-top: var(--cf-spacing-12, 3rem);
  }
  .pt-16 {
    padding-top: var(--cf-spacing-16, 4rem);
  }
  .pt-20 {
    padding-top: var(--cf-spacing-20, 5rem);
  }
  .pt-24 {
    padding-top: var(--cf-spacing-24, 6rem);
  }
  .pt-xs {
    padding-top: var(--cf-spacing-xs, 0.125rem);
  }
  .pt-sm {
    padding-top: var(--cf-spacing-sm, 0.25rem);
  }
  .pt-md {
    padding-top: var(--cf-spacing-md, 0.5rem);
  }
  .pt-lg {
    padding-top: var(--cf-spacing-lg, 0.75rem);
  }
  .pt-xl {
    padding-top: var(--cf-spacing-xl, 1rem);
  }

  /* Padding-right utilities */
  .pr-0 {
    padding-right: var(--cf-spacing-0, 0);
  }
  .pr-1 {
    padding-right: var(--cf-spacing-1, 0.25rem);
  }
  .pr-2 {
    padding-right: var(--cf-spacing-2, 0.5rem);
  }
  .pr-3 {
    padding-right: var(--cf-spacing-3, 0.75rem);
  }
  .pr-4 {
    padding-right: var(--cf-spacing-4, 1rem);
  }
  .pr-5 {
    padding-right: var(--cf-spacing-5, 1.25rem);
  }
  .pr-6 {
    padding-right: var(--cf-spacing-6, 1.5rem);
  }
  .pr-8 {
    padding-right: var(--cf-spacing-8, 2rem);
  }
  .pr-10 {
    padding-right: var(--cf-spacing-10, 2.5rem);
  }
  .pr-12 {
    padding-right: var(--cf-spacing-12, 3rem);
  }
  .pr-16 {
    padding-right: var(--cf-spacing-16, 4rem);
  }
  .pr-20 {
    padding-right: var(--cf-spacing-20, 5rem);
  }
  .pr-24 {
    padding-right: var(--cf-spacing-24, 6rem);
  }
  .pr-xs {
    padding-right: var(--cf-spacing-xs, 0.125rem);
  }
  .pr-sm {
    padding-right: var(--cf-spacing-sm, 0.25rem);
  }
  .pr-md {
    padding-right: var(--cf-spacing-md, 0.5rem);
  }
  .pr-lg {
    padding-right: var(--cf-spacing-lg, 0.75rem);
  }
  .pr-xl {
    padding-right: var(--cf-spacing-xl, 1rem);
  }

  /* Padding-bottom utilities */
  .pb-0 {
    padding-bottom: var(--cf-spacing-0, 0);
  }
  .pb-1 {
    padding-bottom: var(--cf-spacing-1, 0.25rem);
  }
  .pb-2 {
    padding-bottom: var(--cf-spacing-2, 0.5rem);
  }
  .pb-3 {
    padding-bottom: var(--cf-spacing-3, 0.75rem);
  }
  .pb-4 {
    padding-bottom: var(--cf-spacing-4, 1rem);
  }
  .pb-5 {
    padding-bottom: var(--cf-spacing-5, 1.25rem);
  }
  .pb-6 {
    padding-bottom: var(--cf-spacing-6, 1.5rem);
  }
  .pb-8 {
    padding-bottom: var(--cf-spacing-8, 2rem);
  }
  .pb-10 {
    padding-bottom: var(--cf-spacing-10, 2.5rem);
  }
  .pb-12 {
    padding-bottom: var(--cf-spacing-12, 3rem);
  }
  .pb-16 {
    padding-bottom: var(--cf-spacing-16, 4rem);
  }
  .pb-20 {
    padding-bottom: var(--cf-spacing-20, 5rem);
  }
  .pb-24 {
    padding-bottom: var(--cf-spacing-24, 6rem);
  }
  .pb-xs {
    padding-bottom: var(--cf-spacing-xs, 0.125rem);
  }
  .pb-sm {
    padding-bottom: var(--cf-spacing-sm, 0.25rem);
  }
  .pb-md {
    padding-bottom: var(--cf-spacing-md, 0.5rem);
  }
  .pb-lg {
    padding-bottom: var(--cf-spacing-lg, 0.75rem);
  }
  .pb-xl {
    padding-bottom: var(--cf-spacing-xl, 1rem);
  }

  /* Padding-left utilities */
  .pl-0 {
    padding-left: var(--cf-spacing-0, 0);
  }
  .pl-1 {
    padding-left: var(--cf-spacing-1, 0.25rem);
  }
  .pl-2 {
    padding-left: var(--cf-spacing-2, 0.5rem);
  }
  .pl-3 {
    padding-left: var(--cf-spacing-3, 0.75rem);
  }
  .pl-4 {
    padding-left: var(--cf-spacing-4, 1rem);
  }
  .pl-5 {
    padding-left: var(--cf-spacing-5, 1.25rem);
  }
  .pl-6 {
    padding-left: var(--cf-spacing-6, 1.5rem);
  }
  .pl-8 {
    padding-left: var(--cf-spacing-8, 2rem);
  }
  .pl-10 {
    padding-left: var(--cf-spacing-10, 2.5rem);
  }
  .pl-12 {
    padding-left: var(--cf-spacing-12, 3rem);
  }
  .pl-16 {
    padding-left: var(--cf-spacing-16, 4rem);
  }
  .pl-20 {
    padding-left: var(--cf-spacing-20, 5rem);
  }
  .pl-24 {
    padding-left: var(--cf-spacing-24, 6rem);
  }
  .pl-xs {
    padding-left: var(--cf-spacing-xs, 0.125rem);
  }
  .pl-sm {
    padding-left: var(--cf-spacing-sm, 0.25rem);
  }
  .pl-md {
    padding-left: var(--cf-spacing-md, 0.5rem);
  }
  .pl-lg {
    padding-left: var(--cf-spacing-lg, 0.75rem);
  }
  .pl-xl {
    padding-left: var(--cf-spacing-xl, 1rem);
  }
`;
