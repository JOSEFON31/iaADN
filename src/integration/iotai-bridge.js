// iaADN - IOTAI Bridge: connects iaADN to the IOTAI cryptocurrency network
// Provides access to DAG storage, wallets, marketplace, and P2P networking

import { resolve } from 'path';
import { existsSync } from 'fs';
import { getConfig } from '../config.js';
import { GenomeCodec } from '../genome/codec.js';

export class IOTAIBridge {
  constructor() {
    this.iotaiPath = getConfig().paths.iotai;
    this.connected = false;
    this.modules = {};
  }

  // Connect to IOTAI — dynamically import its modules
  async connect() {
    if (!existsSync(this.iotaiPath)) {
      console.warn(`[IOTAIBridge] IOTAI not found at ${this.iotaiPath}, running in standalone mode`);
      this.connected = false;
      return false;
    }

    try {
      const srcPath = resolve(this.iotaiPath, 'src');

      // Convert Windows paths to file:// URLs for dynamic import
      const toFileUrl = (p) => {
        const resolved = resolve(p);
        return `file:///${resolved.replace(/\\/g, '/')}`;
      };

      // Import IOTAI core modules
      this.modules.DAG = (await import(toFileUrl(resolve(srcPath, 'core/dag.js')))).default ||
                         (await import(toFileUrl(resolve(srcPath, 'core/dag.js')))).DAG;
      this.modules.Transaction = (await import(toFileUrl(resolve(srcPath, 'core/transaction.js')))).default ||
                                  (await import(toFileUrl(resolve(srcPath, 'core/transaction.js'))));
      this.modules.Crypto = (await import(toFileUrl(resolve(srcPath, 'core/crypto.js')))).default ||
                             (await import(toFileUrl(resolve(srcPath, 'core/crypto.js'))));
      this.modules.Wallet = (await import(toFileUrl(resolve(srcPath, 'wallet/wallet.js')))).default ||
                             (await import(toFileUrl(resolve(srcPath, 'wallet/wallet.js')))).Wallet;

      this.connected = true;
      console.log('[IOTAIBridge] Connected to IOTAI');
      return true;
    } catch (err) {
      console.warn(`[IOTAIBridge] Failed to connect to IOTAI: ${err.message}`);
      this.connected = false;
      return false;
    }
  }

  // Create a new wallet for an iaADN instance
  async createWallet() {
    if (!this.connected) return this._mockWallet();
    const wallet = new this.modules.Wallet();
    return wallet;
  }

  // Store a genome on the DAG
  async storeGenome(wallet, genome) {
    const metadata = GenomeCodec.toDAGMetadata(genome);
    if (!this.connected) {
      return { stored: true, mock: true, metadata };
    }

    try {
      const dag = this.modules.DAG;
      const result = await wallet.sendData(dag.getTips(), metadata);
      return { stored: true, txId: result?.id, metadata };
    } catch (err) {
      return { stored: false, error: err.message, metadata };
    }
  }

  // Store a birth record on the DAG
  async recordBirth(wallet, genome, fitnessScore) {
    const metadata = GenomeCodec.createBirthRecord(genome, fitnessScore);
    if (!this.connected) {
      return { recorded: true, mock: true, metadata };
    }

    try {
      const dag = this.modules.DAG;
      await wallet.sendData(dag.getTips(), metadata);
      return { recorded: true, metadata };
    } catch (err) {
      return { recorded: false, error: err.message };
    }
  }

  // Store a death record on the DAG
  async recordDeath(wallet, instanceId, reason, lastFitness) {
    const metadata = GenomeCodec.createDeathRecord(instanceId, reason, lastFitness);
    if (!this.connected) {
      return { recorded: true, mock: true, metadata };
    }

    try {
      const dag = this.modules.DAG;
      await wallet.sendData(dag.getTips(), metadata);
      return { recorded: true, metadata };
    } catch (err) {
      return { recorded: false, error: err.message };
    }
  }

  // Store fitness results on the DAG
  async recordFitness(wallet, instanceId, fitnessResult) {
    const metadata = GenomeCodec.createFitnessRecord(instanceId, fitnessResult);
    if (!this.connected) {
      return { recorded: true, mock: true, metadata };
    }

    try {
      const dag = this.modules.DAG;
      await wallet.sendData(dag.getTips(), metadata);
      return { recorded: true, metadata };
    } catch (err) {
      return { recorded: false, error: err.message };
    }
  }

  // Store evolution generation event on the DAG
  async recordEvolution(wallet, generationNumber, stats) {
    const metadata = GenomeCodec.createEvolutionRecord(generationNumber, stats);
    if (!this.connected) {
      return { recorded: true, mock: true, metadata };
    }

    try {
      const dag = this.modules.DAG;
      await wallet.sendData(dag.getTips(), metadata);
      return { recorded: true, metadata };
    } catch (err) {
      return { recorded: false, error: err.message };
    }
  }

  // Pay for compute resources
  async payForCompute(wallet, workerAddress, amount, taskId) {
    if (!this.connected) {
      return { paid: true, mock: true, amount, taskId };
    }

    try {
      const result = await wallet.send(workerAddress, amount, {
        _iaADN: 'compute_payment',
        taskId,
      });
      return { paid: true, txId: result?.id, amount };
    } catch (err) {
      return { paid: false, error: err.message };
    }
  }

  // Check if connected to IOTAI
  isConnected() {
    return this.connected;
  }

  // Mock wallet for standalone mode
  _mockWallet() {
    return {
      address: 'iotai_mock_' + Math.random().toString(36).slice(2, 14),
      sendData: async () => ({ id: 'mock_tx_' + Date.now() }),
      send: async () => ({ id: 'mock_tx_' + Date.now() }),
      getBalance: () => 1000000,
    };
  }
}
