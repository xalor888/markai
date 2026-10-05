/** 滑块：数字范围选择。
 *
 *  为什么不用原生 `input[type=range]`：那是浏览器默认外观（灰蓝轨道 + 方形把手），
 *  与整套设计不搭，且**深色模式下不会被 token 接管**（轨道仍是系统灰）。
 *  这里用原生 range 做语义与键盘可达性（←/→/Home/End 全部免费），只重画外观层。
 */
export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  id,
  'aria-label': ariaLabel,
  className,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  id?: string;
  'aria-label'?: string;
  className?: string;
}) {
  // 填充比例：驱动轨道左侧的强调色宽度
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <input
      id={id}
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      aria-label={ariaLabel}
      onChange={(e) => onChange(Number(e.target.value))}
      className={['markai-slider', className].filter(Boolean).join(' ')}
      style={{ '--markai-slider-pct': `${pct}%` } as React.CSSProperties}
    />
  );
}
