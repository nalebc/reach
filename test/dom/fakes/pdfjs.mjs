export const state = {
  options: [],
  pages: [],
  cancelled: 0,
  destroyed: 0,
  bridgesDestroyed: 0,
  failure: null,
  size: [420, 260],
};
export function reset() {
  state.options = [];
  state.pages = [];
  state.cancelled = 0;
  state.destroyed = 0;
  state.bridgesDestroyed = 0;
  state.failure = null;
  state.size = [420, 260];
}
export const AnnotationMode = { DISABLE: 0 };
export class PDFWorker {
  static create(options) {
    return new PDFWorker(options);
  }
  constructor({ port }) {
    this.port = port;
  }
  destroy() {
    state.bridgesDestroyed++;
  }
}
export function getDocument(options) {
  state.options.push(options);
  return {
    promise: state.failure
      ? Promise.reject(state.failure)
      : Promise.resolve({
          numPages: 2,
          async getPage(page) {
            return {
              getViewport: ({ scale }) => ({
                width: state.size[0] * scale,
                height: state.size[1] * scale,
              }),
              render({ canvas, annotationMode }) {
                state.pages.push({
                  page,
                  annotationMode,
                  width: canvas.width,
                  height: canvas.height,
                });
                canvas.dataset.renderedPage = String(page);
                return {
                  promise: Promise.resolve(),
                  cancel() {
                    state.cancelled++;
                  },
                };
              },
              cleanup() {},
            };
          },
        }),
    async destroy() {
      state.destroyed++;
    },
  };
}
