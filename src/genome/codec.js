// iaADN - Codec: serialize/deserialize genomes for DAG storage and P2P transfer

import { Genome } from './genome.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { getConfig } from '../config.js';

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

  // Encode genome for P2P network transfer (compact binary-friendly format)
  static toTransferFormat(genome) {
    return {
      type: 'genome_transfer',
      version: 1,
      payload: genome.toJSON(),
      timestamp: Date.now(),
    };
  }

  // Decode genome from P2P transfer format
  static fromTransferFormat(data) {
    if (data.type !== 'genome_transfer') {
      throw new Error('Invalid transfer format');
    }
    return Genome.fromJSON(data.payload);
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
