// iaADN - Species: behavioral clustering of AI instances
// Prevents convergence — maintains diversity through speciation

export class SpeciesManager {
  constructor({ distanceThreshold = 0.3 } = {}) {
    this.distanceThreshold = distanceThreshold;
    this.species = []; // Array of { id, representative, members[] }
    this.nextSpeciesId = 1;
  }

  // Classify all genomes into species
  classify(genomes) {
    this.species = [];

    for (const genome of genomes) {
      let placed = false;

      for (const sp of this.species) {
        const distance = genome.distanceTo(sp.representative);
        if (distance < this.distanceThreshold) {
          sp.members.push(genome);
          placed = true;
          break;
        }
      }

      if (!placed) {
        // New species
        this.species.push({
          id: this.nextSpeciesId++,
          representative: genome,
          members: [genome],
        });
      }
    }

    return this.species;
  }

  // Get species count
  getCount() {
    return this.species.length;
  }

  // Get species info
  getInfo() {
    return this.species.map(sp => ({
      id: sp.id,
      size: sp.members.length,
      representativeId: sp.representative.instanceId,
      topSpecialization: getTopSpecialization(sp.representative),
    }));
  }

  // Get the species a genome belongs to
  getSpeciesOf(genomeInstanceId) {
    for (const sp of this.species) {
      if (sp.members.some(m => m.instanceId === genomeInstanceId)) {
        return sp;
      }
    }
    return null;
  }
}

function getTopSpecialization(genome) {
  const spec = genome.getSpecialization();
  let topKey = 'general';
  let topVal = 0;
  for (const [key, val] of Object.entries(spec)) {
    if (val > topVal) {
      topKey = key;
      topVal = val;
    }
  }
  return topKey;
}
