import { ReachScene } from "./ReachIdentity";

export default function DeviceSignal({
  className = "",
  companion = false,
}: {
  className?: string;
  companion?: boolean;
  connections?: boolean | number;
}) {
  return (
    <ReachScene
      mode="computer"
      companion={companion}
      className={`device-signal ${className}`}
    />
  );
}
