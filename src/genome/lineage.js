// iaADN - Lineage: family tree tracking for AI instances
// Records births, deaths, and ancestry on the IOTAI DAG

export class Lineage {
  constructor() {
    // In-memory lineage graph: instanceId -> { parentIds, childIds, generation, alive, fitness, birthTime, deathTime }
    this.tree = new Map();
  }

  // Record a birth
  recordBirth(genome, fitnessScore = null) {
    const entry = {
      instanceId: genome.instanceId,
      parentIds: genome.parentIds,
      childIds: [],
      generation: genome.generation,
      alive: true,
      fitness: fitnessScore,
      birthTime: Date.now(),
      deathTime: null,
      birthNode: genome.birthNode,
      genomeHash: genome.hash(),
    };

    this.tree.set(genome.instanceId, entry);

    // Update parents' child lists
    for (const parentId of genome.parentIds) {
      const parent = this.tree.get(parentId);
      if (parent) {
        parent.childIds.push(genome.instanceId);
      }
    }

    return entry;
  }

  // Record a death
  recordDeath(instanceId, reason) {
    const entry = this.tree.get(instanceId);
    if (!entry) return null;

    entry.alive = false;
    entry.deathTime = Date.now();
    entry.deathReason = reason;
    return entry;
  }

  // Update fitness score
  updateFitness(instanceId, fitnessScore) {
    const entry = this.tree.get(instanceId);
    if (entry) {
      entry.fitness = fitnessScore;
    }
  }

  // Get ancestry chain (parents, grandparents, etc.)
  getAncestors(instanceId, maxDepth = 10) {
    const ancestors = [];
    const visited = new Set();
    const queue = [{ id: instanceId, depth: 0 }];

    while (queue.length > 0) {
      const { id, depth } = queue.shift();
      if (depth > maxDepth || visited.has(id)) continue;
      visited.add(id);

      const entry = this.tree.get(id);
      if (!entry) continue;

      if (depth > 0) ancestors.push(entry);

      for (const parentId of entry.parentIds) {
        queue.push({ id: parentId, depth: depth + 1 });
      }
    }

    return ancestors;
  }

  // Get all living descendants
  getDescendants(instanceId) {
    const descendants = [];
    const visited = new Set();
    const queue = [instanceId];

    while (queue.length > 0) {
      const id = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);

      const entry = this.tree.get(id);
      if (!entry) continue;

      for (const childId of entry.childIds) {
        const child = this.tree.get(childId);
        if (child) {
          descendants.push(child);
          queue.push(childId);
        }
      }
    }

    return descendants;
  }

  // Get all living instances
  getLiving() {
    const living = [];
    for (const entry of this.tree.values()) {
      if (entry.alive) living.push(entry);
    }
    return living;
  }

  // Get population statistics
  getStats() {
    let living = 0;
    let dead = 0;
    let totalFitness = 0;
    let bestFitness = 0;
    let maxGeneration = 0;

    for (const entry of this.tree.values()) {
      if (entry.alive) {
        living++;
        if (entry.fitness != null) {
          totalFitness += entry.fitness;
          bestFitness = Math.max(bestFitness, entry.fitness);
        }
      } else {
        dead++;
      }
      maxGeneration = Math.max(maxGeneration, entry.generation);
    }

    return {
      living,
      dead,
      total: this.tree.size,
      avgFitness: living > 0 ? totalFitness / living : 0,
      bestFitness,
      currentGeneration: maxGeneration,
    };
  }

  // Find most recent common ancestor
  findMRCA(instanceIdA, instanceIdB) {
    const ancestorsA = new Set();
    const queueA = [instanceIdA];

    // Collect all ancestors of A
    while (queueA.length > 0) {
      const id = queueA.shift();
      if (ancestorsA.has(id)) continue;
      ancestorsA.add(id);
      const entry = this.tree.get(id);
      if (entry) queueA.push(...entry.parentIds);
    }

    // BFS from B, first ancestor that's also in A's ancestors is the MRCA
    const queueB = [instanceIdB];
    const visitedB = new Set();
    while (queueB.length > 0) {
      const id = queueB.shift();
      if (visitedB.has(id)) continue;
      visitedB.add(id);

      if (ancestorsA.has(id) && id !== instanceIdA && id !== instanceIdB) {
        return this.tree.get(id);
      }

      const entry = this.tree.get(id);
      if (entry) queueB.push(...entry.parentIds);
    }

    return null; // no common ancestor
  }

  toJSON() {
    return Array.from(this.tree.values());
  }

  static fromJSON(entries) {
    const lineage = new Lineage();
    for (const entry of entries) {
      lineage.tree.set(entry.instanceId, entry);
    }
    return lineage;
  }
}
