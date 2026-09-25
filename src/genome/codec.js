// iaADN - Codec: serialize/deserialize genomes for DAG storage and P2P transfer

import { Genome } from './genome.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { getConfig } from '../config.js';
import { signHash, verifyHash } from '../network/identity.js';

export class GenomeCodec {
  // Encode genome to DAG metadata format (for IOTAI bridge)
  static toDAGMetadata(genome) {
    return {
      _iaADN: 'genome',
      instanceId: genome.instanceId,
      parentIds: genome.parentIds,
      generation: genome.generation,
      hash: genome.hash(),
      geneCount: genome.geneCount,
      createdAt: genome.createdAt,
      birthNode: genome.birthNode,
      // Full genome data as stringified JSON (DAG metadata supports nested objects)
      genomeData: JSON.stringify(genome.toJSON()),
    };
  }

  // Decode genome from DAG metadata
  static fromDAGMetadata(metadata) {
    if (metadata._iaADN !== 'genome') {
      throw new Error('Invalid metadata: not a genome record');
    }
    const json = JSON.parse(metadata.genomeData);
    return Genome.fromJSON(json);
  }

  // Save genome to local filesystem
  static saveToFile(genome, dir) {
    const targetDir = dir || resolve(getConfig().paths.genomes);
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }
    const filePath = resolve(targetDir, `${genome.instanceId}.json`);
    writeFileSync(filePath, JSON.stringify(genome.toJSON(), null, 2), 'utf-8');
    return filePath;
  }

  // Load genome from local filesystem
  static loadFromFile(instanceId, dir) {
    const targetDir = dir || resolve(getConfig().paths.genomes);
    const filePath = resolve(targetDir, `${instanceId}.json`);
    if (!existsSync(filePath)) {
      throw new Error(`Genome file not found: ${filePath}`);
    }
    const json = JSON.parse(readFileSync(filePath, 'utf-8'));
    return Genome.fromJSON(json);
  }

  // Encode genome for P2P network transfer (compact binary-friendly format).
  // `identity` (from src/network/identity.js), if given, signs the genome's
  // hash so a receiving node can verify it really came from this node and
  // wasn't altered in transit — see docs/PLAN_EVOLUCION.md Fase 4.
  static toTransferFormat(genome, identity = null) {
    const envelope = {
      type: 'genome_transfer',
      version: 1,
      payload: genome.toJSON(),
      timestamp: Date.now(),
    };
    if (identity) {
      envelope.signature = signHash(genome.hash(), identity.privateKey);
      envelope.publicKey = identity.publicKeyBase64;
    }
    return envelope;
  }

  // Decode genome from P2P transfer format. With `requireSignature: true`
  // (the default for anything arriving over the network — see
  // src/network/node.js), an unsigned or invalid-signature envelope throws
  // instead of silently accepting the genome.
  static fromTransferFormat(data, { requireSignature = false } = {}) {
    if (data.type !== 'genome_transfer') {
      throw new Error('Invalid transfer format');
    }
    const genome = Genome.fromJSON(data.payload);

    let verified = false;
    if (data.signature && data.publicKey) {
      verified = verifyHash(genome.hash(), data.signature, data.publicKey);
    }
    if (requireSignature && !verified) {
      throw new Error('Genome rejected: missing or invalid signature');
    }

    return { genome, verified, publicKey: data.publicKey || null };
  }

  // Create a birth record for DAG (lightweight, without full genome data)
  static createBirthRecord(genome, fitnessScore = null) {
    return {
      _iaADN: 'birth',
      instanceId: genome.instanceId,
      parentIds: genome.parentIds,
      generation: genome.generation,
      genomeHash: genome.hash(),
      geneCount: genome.geneCount,
      birthNode: genome.birthNode,
      fitnessScore,
      timestamp: Date.now(),
    };
  }

  // Create a death record for DAG
  static createDeathRecord(instanceId, reason, lastFitness) {
    return {
      _iaADN: 'death',
      instanceId,
      reason,
      lastFitness,
      timestamp: Date.now(),
    };
  }

  // Create a fitness record for DAG
  static createFitnessRecord(instanceId, fitnessResult) {
    return {
      _iaADN: 'fitness',
      instanceId,
      ...fitnessResult,
      timestamp: Date.now(),
    };
  }

  // Create an evolution event record for DAG
  static createEvolutionRecord(generationNumber, stats) {
    return {
      _iaADN: 'evolution',
      generation: generationNumber,
      populationSize: stats.populationSize,
      avgFitness: stats.avgFitness,
      bestFitness: stats.bestFitness,
      births: stats.births,
      deaths: stats.deaths,
      speciesCount: stats.speciesCount,
      timestamp: Date.now(),
    };
  }
}
