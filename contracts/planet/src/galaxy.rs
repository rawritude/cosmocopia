/// Galaxy sectors.
///
/// Sector boundaries use integer r² thresholds (no sqrt in no_std land).
pub const SECTOR_INNER_CORE: u8 = 0;
pub const SECTOR_HABITABLE_BELT: u8 = 1;
pub const SECTOR_ASTEROID_FIELD: u8 = 2;
pub const SECTOR_FRONTIER: u8 = 3;
pub const SECTOR_OUTER_DARK: u8 = 4;

pub fn sector_of(x: i32, y: i32) -> u8 {
    let xa = (x as i64).unsigned_abs();
    let ya = (y as i64).unsigned_abs();
    let r2: u64 = xa.saturating_mul(xa).saturating_add(ya.saturating_mul(ya));
    if r2 < 25 {
        SECTOR_INNER_CORE
    } else if r2 < 225 {
        SECTOR_HABITABLE_BELT
    } else if r2 < 900 {
        SECTOR_ASTEROID_FIELD
    } else if r2 < 2500 {
        SECTOR_FRONTIER
    } else {
        SECTOR_OUTER_DARK
    }
}

/// Squared Euclidean distance between two coords. Used for conjunction cost.
pub fn dist2(a: (i32, i32), b: (i32, i32)) -> u64 {
    let dx = (a.0 as i64) - (b.0 as i64);
    let dy = (a.1 as i64) - (b.1 as i64);
    let dx = dx.unsigned_abs();
    let dy = dy.unsigned_abs();
    dx.saturating_mul(dx).saturating_add(dy.saturating_mul(dy))
}
