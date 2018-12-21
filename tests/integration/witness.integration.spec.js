const {describe, it} = require('mocha');
const {assert} = require('chai');
const os = require('os');
const debugLib = require('debug');
const sinon = require('sinon');

const factory = require('../testFactory');
const {pseudoRandomBuffer, createDummyTx} = require('../testUtil');

const debugWitness = debugLib('witness:app');

const maxConnections = os.platform() === 'win32' ? 4 : 10;
//const maxConnections = 2;

// set to undefined to use random delays
//const delay = undefined;
const delay = 10;

let groupId = 11;
let arrKeyPairs;
let groupDefinition;

const createDummyDefinition = (groupId = 0, numOfKeys = 2) => {
    const arrKeyPairs = [];
    const arrPublicKeys = [];
    for (let i = 0; i < numOfKeys; i++) {
        const keyPair = factory.Crypto.createKeyPair();
        arrKeyPairs.push(keyPair);
        arrPublicKeys.push(keyPair.publicKey);
    }
    const groupDefinition = factory.WitnessGroupDefinition.create(groupId, arrPublicKeys);

    return {arrKeyPairs, groupDefinition};
};

let witnesNo = 1;
const createWitnesses = (num, seedAddress) => {
    const arrWitnesses = [];

    for (let i = 0; i < num; i++) {
        const witnessWallet = new factory.Wallet(arrKeyPairs[i].getPrivate());
        arrWitnesses.push(new factory.Witness({
            wallet: witnessWallet,
            arrTestDefinition: [groupDefinition],
            listenAddr: factory.Transport.generateAddress(),
            delay,
            arrSeedAddresses: [seedAddress]
        }));
    }
    witnesNo += num;

    return arrWitnesses;
};

const createGenezisBlock = () => {
    const tx = new factory.Transaction(createDummyTx());
    const block = new factory.Block(0);
    block.addTx(tx);
    block.finish(0, pseudoRandomBuffer(33));
    factory.Constants.GENEZIS_BLOCK = block.hash();

    return block;
};

const createGenezisBlockAndSpendingTx = (witnessGroupId = 0) => {
    const receiverKeyPair = factory.Crypto.createKeyPair();
    const buffReceiverAddress = factory.Crypto.getAddress(receiverKeyPair.publicKey, true);

    // create "genezis" tx
    const txGen = new factory.Transaction();
    txGen.witnessGroupId = witnessGroupId;
    txGen.addInput(Buffer.alloc(32), 0);
    txGen.addReceiver(1000000, buffReceiverAddress);

    // create "genezis" block
    const genezis = new factory.Block(0);
    genezis.addTx(txGen);
    genezis.finish(0, pseudoRandomBuffer(33));
    factory.Constants.GENEZIS_BLOCK = genezis.getHash();

    // create spending tx
    const tx = new factory.Transaction();
    tx.witnessGroupId = witnessGroupId;
    tx.addInput(txGen.hash(), 0);
    tx.addReceiver(1000, buffReceiverAddress);
    tx.sign(0, receiverKeyPair.privateKey);

    return {genezis, tx};
};

describe('Witness integration tests', () => {
    before(async function() {
        this.timeout(15000);
        await factory.asyncLoad();

        ({arrKeyPairs, groupDefinition} = createDummyDefinition(groupId, maxConnections));
    });

    after(async function() {
        this.timeout(15000);
    });

    it('should ACT same as regular node (get peers from seedNode)', async function() {
        this.timeout(maxConnections * 60000);

        const genezis = createGenezisBlock();

        const seedAddress = factory.Transport.generateAddress();
        const seedNode = new factory.Node({listenAddr: seedAddress, delay});
        await seedNode._processBlock(genezis);

        // Peers already known by seedNode
        const peerInfo1 = new factory.Messages.PeerInfo({
            capabilities: [
                {service: factory.Constants.NODE, data: null}
            ],
            address: factory.Transport.strToAddress(factory.Transport.generateAddress())
        });
        const peerInfo2 = new factory.Messages.PeerInfo({
            capabilities: [
                {service: factory.Constants.WITNESS, data: Buffer.from('2222')}
            ],
            address: factory.Transport.strToAddress(factory.Transport.generateAddress())
        });
        [peerInfo1, peerInfo2].forEach(peerInfo => seedNode._peerManager.addPeer(peerInfo));

        // create 'maxConnections' witnesses
        const arrWitnesses = createWitnesses(maxConnections, seedAddress);

        await Promise.all(arrWitnesses.map(witness => witness.bootstrap()));

        // there should be maxConnections+2 peers added to seed
        const arrPeers = seedNode._peerManager.filterPeers();
        assert.equal(arrPeers.length, maxConnections + 2);

        await Promise.all(arrWitnesses.map(witness => witness.start()));
    });

    it('should NOT commit block (empty mempool)', async function() {
        this.timeout(maxConnections * 60000);
        const genezis = createGenezisBlock();

        const seedAddress = factory.Transport.generateAddress();
        const seedNode = new factory.Node({listenAddr: seedAddress, delay});
        await seedNode._processBlock(genezis);

        // create 'maxConnections' witnesses
        const arrWitnesses = createWitnesses(maxConnections, seedAddress);

        const createBlockFake = sinon.fake();

        const arrSuppressedBlocksPromises = [];
        for (let i = 0; i < arrWitnesses.length; i++) {
            await arrWitnesses[i]._processBlock(genezis);
            arrSuppressedBlocksPromises.push(new Promise(resolve => {
                arrWitnesses[i]._suppressedBlockHandler = resolve;
                arrWitnesses[i]._acceptBlock = createBlockFake;
            }));
        }
        await Promise.all(arrWitnesses.map(witness => witness.bootstrap()));
        await Promise.all(arrWitnesses.map(witness => witness.start()));

        // all witnesses should call _suppressedBlockHandler
        await Promise.all(arrSuppressedBlocksPromises);

        assert.equal(createBlockFake.callCount, 0);
    });

    it('should commit one block (tx in mempool)', async function() {
        this.timeout(maxConnections * 60000);

        const {genezis, tx} = createGenezisBlockAndSpendingTx(groupId);

        const seedAddress = factory.Transport.generateAddress();
        const seedNode = new factory.Node({listenAddr: seedAddress, delay, arrTestDefinition: [groupDefinition]});
        await seedNode._processBlock(genezis);

        // create 'maxConnections' witnesses
        const arrWitnesses = createWitnesses(maxConnections, seedAddress);

        // prepare Done handlers for all witnesses & seedNode
        const arrBlocksPromises = [];
        for (let i = 0; i < arrWitnesses.length; i++) {

            await arrWitnesses[i]._processBlock(genezis);

            arrBlocksPromises.push(new Promise(resolve => {
                arrWitnesses[i]._postAccepBlock = resolve;
            }));
            arrWitnesses[i]._canExecuteBlock = sinon.fake.returns(true);
        }

        // add seed to array also
        arrBlocksPromises.push(new Promise(resolve => {
            seedNode._postAccepBlock = resolve;
        }));
        seedNode._canExecuteBlock = sinon.fake.returns(true);

        // run
        await Promise.all(arrWitnesses.map(witness => witness.bootstrap()));
        await Promise.all(arrWitnesses.map(witness => witness.start()));

        // inject TX into network
        seedNode.rpc.sendRawTx(tx.encode());

        // all witnesses + seedNode should get block (_acceptBlock called)
        await Promise.all(arrBlocksPromises);
    });

    it('should NOT commit block (there is TX in mempool, but wrong witnessGroupId)', async function() {
        this.timeout(maxConnections * 60000);

        const {genezis, tx} = createGenezisBlockAndSpendingTx(2);

        const seedAddress = factory.Transport.generateAddress();
        const seedNode = new factory.Node({listenAddr: seedAddress, delay});
        await seedNode._processBlock(genezis);

        // create 'maxConnections' witnesses
        const arrWitnesses = createWitnesses(maxConnections, seedAddress);
        for (let witness of arrWitnesses) await witness._processBlock(genezis);

        const acceptBlockFake = sinon.fake();

        const arrSuppressedBlocksPromises = [];
        for (let i = 0; i < arrWitnesses.length; i++) {
            arrSuppressedBlocksPromises.push(new Promise(resolve => {
                arrWitnesses[i]._suppressedBlockHandler = resolve;
                arrWitnesses[i]._acceptBlock = acceptBlockFake;
            }));
        }
        await Promise.all(arrWitnesses.map(witness => witness.bootstrap()));
        await Promise.all(arrWitnesses.map(witness => witness.start()));

        seedNode.rpc.sendRawTx(tx.encode());

        // all witnesses should call _suppressedBlockHandler
        await Promise.all(arrSuppressedBlocksPromises);

        // ensure that no block was accepted
        assert.equal(acceptBlockFake.callCount, 0);
    });

//    it('should DISCONNECT from FAKE Witness', async () => {

//        const kpTest = factory.Crypto.createKeyPair();
//        const kpGood = factory.Crypto.createKeyPair();
//        const kpWalletFake = factory.Crypto.createKeyPair();
//
//        const groupName = 'test';
//        const arrTestDefinition = [
//            [groupName, [kpTest.getPublic(), kpGood.getPublic()]],
//            ['anotherGroup', ['pubkey3', 'pubkey4']]
//        ];
//
//        // create fake
//        const fakeAddress=factory.Transport.strToAddress(`fake witness`);
//        const fakeWitnessWallet = new factory.Wallet(kpWalletFake.getPrivate());
//        const fakeWitness=new factory.Witness({
//            wallet: fakeWitnessWallet, arrTestDefinition,
//            listenAddr: fakeAddress, delay: 10,
//            arrSeedAddresses: []
//        });
//
//        // start our witness
//        const wallet = new factory.Wallet(kpTest.getPrivate());
//        const testWitness = new factory.Witness(
//            {
//                wallet, arrTestDefinition,
//                listenAddr: factory.Transport.strToAddress('Test witness 2'),
//                delay: 10, queryTimeout: 5000, arrSeedAddresses: [fakeAddress]
//            });
//        await testWitness.bootstrap();
//        await testWitness.start();

//    });
});
