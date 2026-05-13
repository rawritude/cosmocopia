import { parseDna, computeRarity } from '@cosmocopia/art';
import RarityBadge from './RarityBadge';

export default function Traits({ dna, coords }: { dna: Uint8Array; coords?: { x: number; y: number } }) {
  const t = parseDna(dna);
  const r = computeRarity({ dna: t, coords });
  return (
    <dl className="traits">
      <dt>Tier</dt><dd><RarityBadge dna={dna} coords={coords} size="md" /> <span style={{color:'var(--stardust)'}}>score {r.score}</span></dd>
      <dt>Class</dt><dd>{t.klass}</dd>
      <dt>Pattern</dt><dd>{t.pattern}</dd>
      <dt>Atmosphere</dt><dd>{t.atmosphere}</dd>
      <dt>Feature</dt><dd>{t.feature} <span style={{color:'var(--stardust)'}}>×{t.featureIntensity}</span></dd>
      <dt>Rings</dt><dd>{t.ringsCount}</dd>
      <dt>Moons</dt><dd>{t.moonCount}</dd>
      <dt>Aura</dt><dd>{t.aura}</dd>
      <dt>Palette</dt><dd>{t.paletteScheme} · hue {Math.round((t.paletteHue/255)*360)}°</dd>
      <dt>Generation</dt><dd>{t.generation}</dd>
      <dt>Rarity nibble</dt><dd>{t.rarity}/15</dd>
      <dt>Birth round</dt><dd>{t.birthRound}</dd>
    </dl>
  );
}
