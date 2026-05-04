interface Props {
  size?: number;
  color?: string;
}

export function Spinner({ size = 24, color = '#e94560' }: Props) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        border: `2px solid ${color}33`,
        borderTopColor: color,
        borderRadius: '50%',
        animation: 'actoviq-spin 0.6s linear infinite',
      }}
    />
  );
}
