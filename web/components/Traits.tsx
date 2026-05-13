import { parseDna } from '@cosmocopia/art';

export default function Traits({ dna }: { dna: Uint8Array }) {
  const t = parseDna(dna);
  return (
    <dl className="traits">
      <dt>Class</dt><dd>{t.klass}</dd>
      <dt>Pattern</dt><dd>{t.pattern}</dd>
      <dt>Atmosphere</dt><dd>{t.atmosphere}</dd>
      <dt>Feature</dt><dd>{t.feature} <span style={{color:'var(--dim)'}}>×{t.featureIntensity}</span></dd>
      <dt>Rings</dt><dd>{t.ringsCount}</dd>
      <dt>Moons</dt><dd>{t.moonCount}</dd>
      <dt>Aura</dt><dd>{t.aura}</dd>
      <dt>Palette</dt><dd>{t.paletteScheme} · hue {Math.round((t.paletteHue/255)*360)}°</dd>
      <dt>Generation</dt><dd>{t.generation}</dd>
      <dt>Rarity</dt><dd>{t.rarity}</dd>
      <dt>Birth round</dt><dd>{t.birthRound}</dd>
    </dl>
  );
}
