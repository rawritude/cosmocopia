use soroban_sdk::contracttype;

use crate::galaxy;

/// Five vitals + last update ledger. Stats are 0..=255 and clamped on every write.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Vitals {
    pub temperature: u32,
    pub hydration: u32,
    pub gravity: u32,
    pub biomass: u32,
    pub spirit: u32,
    pub last_ledger: u32,
}

const HEALTHY_MIN: u32 = 40;
const HEALTHY_MAX: u32 = 220;
pub const VITAL_MAX: u32 = 255;

/// Decay per `DECAY_PERIOD_LEDGERS` ledgers, indexed by class (0..16).
/// Positive = drift up, negative = drift down. Stored as i8 to keep the table tiny.
pub const DECAY_PERIOD_LEDGERS: u32 = 720; // ~1h at 5s ledgers

// (dTemp, dHydro, dGravity, dBiomass, dSpirit)
const CLASS_DECAY: [(i8, i8, i8, i8, i8); 16] = [
    /* 0  Rocky   */ (0, -1, 0, -1, -1),
    /* 1  Gas     */ (1, 0, -1, 0, -1),
    /* 2  Ocean   */ (-1, 1, 0, 0, 0),
    /* 3  Lava    */ (2, -3, 0, -1, -1),
    /* 4  Ice     */ (-2, 0, 0, -1, -1),
    /* 5  Desert  */ (1, -2, 0, -2, -1),
    /* 6  Jungle  */ (0, -1, 0, -2, 0),
    /* 7  Crystal */ (0, 0, 1, -1, 1),
    /* 8  Void    */ (-1, -1, -1, -2, -2),
    /* 9  Forge   */ (2, -1, 0, -1, -1),
    /* 10 Bloom   */ (0, 0, 0, 1, 1),
    /* 11 Cinder  */ (1, -2, 0, -1, -1),
    /* 12 Mist    */ (0, 1, 0, 0, 0),
    /* 13 Quartz  */ (0, 0, 1, 0, 0),
    /* 14 Hollow  */ (-1, -1, -2, -1, -1),
    /* 15 Aether  */ (0, 0, 0, 0, 2),
];

// Sector drift modifier per (dTemp, dHydro, dGravity, dBiomass, dSpirit).
const SECTOR_DRIFT: [(i8, i8, i8, i8, i8); 5] = [
    /* 0 Inner Core      */ (1, -1, 2, 0, 0),
    /* 1 Habitable Belt  */ (0, 0, 0, 1, 1),
    /* 2 Asteroid Field  */ (0, -1, 1, -2, 0),
    /* 3 Frontier        */ (-1, 0, 0, -1, 2),
    /* 4 Outer Dark      */ (-2, -1, -1, -1, -1),
];

fn clamp_add(v: u32, delta: i32) -> u32 {
    let new = v as i32 + delta;
    if new < 0 {
        0
    } else if new > VITAL_MAX as i32 {
        VITAL_MAX
    } else {
        new as u32
    }
}

/// Compute the current decayed vitals without writing back to storage.
pub fn project(stored: &Vitals, now: u32, class: u8, coords: (i32, i32)) -> Vitals {
    let elapsed = now.saturating_sub(stored.last_ledger);
    let periods = (elapsed / DECAY_PERIOD_LEDGERS) as i32;
    if periods == 0 {
        return stored.clone();
    }
    let c = CLASS_DECAY[(class as usize) & 0x0F];
    let s = SECTOR_DRIFT[galaxy::sector_of(coords.0, coords.1) as usize];
    Vitals {
        temperature: clamp_add(stored.temperature, (c.0 as i32 + s.0 as i32) * periods),
        hydration: clamp_add(stored.hydration, (c.1 as i32 + s.1 as i32) * periods),
        gravity: clamp_add(stored.gravity, (c.2 as i32 + s.2 as i32) * periods),
        biomass: clamp_add(stored.biomass, (c.3 as i32 + s.3 as i32) * periods),
        spirit: clamp_add(stored.spirit, (c.4 as i32 + s.4 as i32) * periods),
        last_ledger: stored
            .last_ledger
            .saturating_add((periods as u32) * DECAY_PERIOD_LEDGERS),
    }
}

#[repr(u32)]
#[derive(Clone, Copy)]
pub enum Care {
    Warm = 0,
    Rain = 1,
    Tide = 2,
    Tend = 3,
    Reflect = 4,
}

impl Care {
    pub fn from_u32(v: u32) -> Option<Care> {
        match v {
            0 => Some(Care::Warm),
            1 => Some(Care::Rain),
            2 => Some(Care::Tide),
            3 => Some(Care::Tend),
            4 => Some(Care::Reflect),
            _ => None,
        }
    }
}

/// Apply a care action. Each action's effect depends on class:
/// the right care for a class buffs the target vital and a sibling vital,
/// the wrong care hurts. This keeps the play loop class-aware.
pub fn apply_care(v: &Vitals, class: u8, action: Care, now: u32) -> Vitals {
    let (dt, dh, dg, db, ds) = effect(class, action);
    Vitals {
        temperature: clamp_add(v.temperature, dt),
        hydration: clamp_add(v.hydration, dh),
        gravity: clamp_add(v.gravity, dg),
        biomass: clamp_add(v.biomass, db),
        spirit: clamp_add(v.spirit, ds),
        last_ledger: now,
    }
}

fn effect(class: u8, action: Care) -> (i32, i32, i32, i32, i32) {
    let class = class & 0x0F;
    use Care::*;
    match action {
        Warm => match class {
            3 /* Lava */ | 9 /* Forge */ | 11 /* Cinder */ => (-15, -5, 0, -5, -5),
            4 /* Ice */ | 12 /* Mist */ | 8 /* Void */ => (25, 0, 0, 0, 10),
            _ => (15, -5, 0, 0, 5),
        },
        Rain => match class {
            3 /* Lava */ | 9 /* Forge */ | 11 /* Cinder */ => (-20, 5, 0, -5, -10),
            2 /* Ocean */ | 6 /* Jungle */ | 12 /* Mist */ | 10 /* Bloom */ => (-5, 25, 0, 10, 5),
            _ => (-5, 15, 0, 5, 0),
        },
        Tide => (0, 0, 12, 0, 3),
        Tend => match class {
            6 /* Jungle */ | 10 /* Bloom */ | 2 /* Ocean */ => (0, 5, 0, 25, 10),
            8 /* Void */ | 14 /* Hollow */ => (0, 0, 0, 5, -5),
            _ => (0, 0, 0, 15, 5),
        },
        Reflect => match class {
            15 /* Aether */ | 7 /* Crystal */ => (0, 0, 0, 0, 25),
            _ => (0, 0, 0, 0, 15),
        },
    }
}

/// Conjunction success modifier — 0 if any vital is critical, 100 if all healthy.
pub fn healthy_factor(v: &Vitals) -> u32 {
    let mut score = 0u32;
    for s in [v.temperature, v.hydration, v.gravity, v.biomass, v.spirit] {
        if s >= HEALTHY_MIN && s <= HEALTHY_MAX {
            score += 20;
        } else if s >= 20 && s <= 240 {
            score += 10;
        }
    }
    score
}
