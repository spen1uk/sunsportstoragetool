export function Setup({ title, phase, needs }: { title: string; phase: string; needs: string }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      <p><span className="badge">Not built yet · {phase}</span></p>
      <p>{needs}</p>
      <p className="muted small">No sample data is shown here on purpose — this screen will only display real information once it is connected.</p>
    </div>
  );
}
