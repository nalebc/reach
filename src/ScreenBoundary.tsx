import { Component, Suspense, type ReactNode } from "react";
import { RefreshCw, House, TriangleAlert } from "lucide-react";
import { Spinner } from "./ui";

/** Keep navigation mounted when a page fails; retry remounts only its contents.
 * Pages whose code loads on demand show a spinner here while it arrives. */
export default class ScreenBoundary extends Component<
  {
    children: ReactNode;
    onHome?: () => void;
  },
  { failed: boolean; attempt: number }
> {
  state = { failed: false, attempt: 0 };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <section className="panel screen-recovery" role="alert">
          <TriangleAlert size={28} />
          <h1>This screen couldn’t open</h1>
          <p>
            Your connection details are still saved. Try again or return to
            Home.
          </p>
          <div className="button-row">
            <button
              className="button primary"
              onClick={() =>
                this.setState((s) => ({
                  failed: false,
                  attempt: s.attempt + 1,
                }))
              }
            >
              <RefreshCw size={17} />
              Try again
            </button>
            <button
              className="button secondary"
              onClick={() =>
                this.props.onHome ? this.props.onHome() : location.reload()
              }
            >
              <House size={17} />
              {this.props.onHome ? "Go Home" : "Reload Reach"}
            </button>
          </div>
        </section>
      );
    return (
      <div key={this.state.attempt} className="screen-boundary-content">
        <Suspense fallback={<Spinner label="Opening…" />}>
          {this.props.children}
        </Suspense>
      </div>
    );
  }
}
