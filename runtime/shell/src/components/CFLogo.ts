import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";

export class CFLogo extends LitElement {
  static override styles = css`
    :host {
      display: inline-block;
      line-height: 0;
    }

    svg {
      display: block;
    }

    @keyframes bounce {
      0%,
      100% {
        transform: translateY(0);
      }
      50% {
        transform: translateY(-15px);
      }
    }

    @keyframes spin {
      0% {
        transform: rotate(0deg);
      }
      100% {
        transform: rotate(360deg);
      }
    }

    @keyframes flip {
      0% {
        transform: rotateY(0deg);
      }
      50% {
        transform: rotateY(180deg);
      }
      100% {
        transform: rotateY(360deg);
      }
    }

    @keyframes pulse-rotate {
      0% {
        transform: scale(1) rotate(0deg);
      }
      50% {
        transform: scale(1.1) rotate(180deg);
      }
      100% {
        transform: scale(1) rotate(360deg);
      }
    }

    :host([loading]) .circle {
      animation: bounce 0.5s ease-in-out infinite;
      transform-origin: center;
    }

    :host([loading]) .triangle {
      animation: spin 0.75s linear infinite;
      transform-origin: center;
      transform-box: fill-box;
    }

    :host([loading]) .rectangle {
      animation: flip 1s ease-in-out infinite;
      transform-origin: center;
      transform-box: fill-box;
    }

    :host([loading]) .star {
      animation: pulse-rotate 1s ease-in-out infinite;
      transform-origin: center;
      transform-box: fill-box;
    }
  `;

  @property()
  accessor width = 32;

  @property()
  accessor height = 32;

  @property({ attribute: "background-color" })
  accessor backgroundColor = "white";

  @property({ attribute: "shape-color" })
  accessor shapeColor = "#f9fafb";

  @property({ type: Boolean, reflect: true })
  accessor loading = false;

  override render() {
    return html`
      <svg
        width="${this.width}"
        height="${this.height}"
        viewBox="0 0 850 850"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect width="850" height="850" rx="80" fill="${this.backgroundColor}" />
        <circle class="circle" cx="244" cy="253.5" r="100" fill="${this
          .shapeColor}" />
        <path
          class="triangle"
          d="M624.248 335.006C613.916 352.998 588.084 352.998 577.752 335.006L499.637 198.983C489.304 180.991 502.22 158.5 522.885 158.5L679.115 158.5C699.78 158.5 712.696 180.991 702.363 198.983L624.248 335.006Z"
          fill="${this.shapeColor}"
        />
        <rect
          class="rectangle"
          x="157"
          y="505.5"
          width="191"
          height="191"
          rx="50"
          fill="${this
            .shapeColor}"
        />
        <path
          class="star"
          d="M575.472 522.851C580.989 501.05 612.011 501.05 617.528 522.851C620.84 535.937 635.203 542.843 647.514 537.27C668.024 527.984 687.366 552.201 673.736 570.102C665.554 580.846 669.101 596.364 681.141 602.499C701.2 612.722 694.297 642.921 671.783 643.44C658.269 643.752 648.33 656.197 651.032 669.421C655.535 691.454 627.585 704.894 613.14 687.642C604.471 677.287 588.529 677.287 579.86 687.642C565.415 704.894 537.465 691.454 541.968 669.421C544.67 656.197 534.731 643.752 521.217 643.44C498.703 642.921 491.8 612.722 511.859 602.499C523.899 596.364 527.446 580.846 519.264 570.102C505.634 552.201 524.976 527.984 545.486 537.27C557.797 542.843 572.16 535.937 575.472 522.851Z"
          fill="${this.shapeColor}"
        />
      </svg>
    `;
  }
}

customElements.define("cf-logo", CFLogo);
