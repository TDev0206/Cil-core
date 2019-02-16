'use strict';

const {describe, it} = require('mocha');
const {assert} = require('chai');

const {prepareForStringifyObject} = require('../utils');

describe('Utils', () => {
    describe('prepareForStringifyObject', () => {
        it('should leave unchanged non Objects and Arrays', async () => {
            assert.equal(undefined, prepareForStringifyObject(undefined));
            assert.equal('test', prepareForStringifyObject('test'));
            assert.equal(1, prepareForStringifyObject(1));
            assert.equal(false, prepareForStringifyObject(false));
            assert.deepEqual([1, 2, 3, 4], prepareForStringifyObject([1, 2, 3, 4]));
        });
        it('should transform Buffer', async () => {
            assert.equal('dead', prepareForStringifyObject(Buffer.from('DEAD', 'hex')));
        });
        it('should transform Buffer', async () => {
            const result = prepareForStringifyObject({buffer: Buffer.from('DEAD', 'hex')});
            assert.deepEqual({buffer: 'dead'}, result);
        });
        it('should transform nested object', async () => {
            const result = prepareForStringifyObject({
                object: {
                    buffer: Buffer.from('DEAD', 'hex')
                }
            });
            assert.deepEqual({object: {buffer: 'dead'}}, result);
        });
        it('should leave primitives unchanged', async () => {
            const expected = {
                number: 1,
                string: 'string',
                boolean: true
            };
            const result = prepareForStringifyObject(expected);
            assert.deepEqual(expected, result);
        });
    });
});
