export default function Input({
  label,
  error,
  success,
  hint,
  className = "",
  id,
  ...rest
}) {
  const inputId = id || rest.name;

  return (
    <div className="dgv-field">
      {label ? (
        <label className="dgv-label" htmlFor={inputId}>
          {label}
        </label>
      ) : null}
      <input
        id={inputId}
        className={`dgv-input ${error ? "is-error" : ""} ${success ? "is-success" : ""} ${className}`.trim()}
        aria-invalid={error ? true : undefined}
        {...rest}
      />
      {error ? <div className="dgv-field-error">{error}</div> : null}
      {!error && hint ? <div className="dgv-field-hint">{hint}</div> : null}
    </div>
  );
}
