const assert = require('node:assert/strict');
const fn = () => require('../../out/generation/plan/BatchNamespacing').planBatchNamespacing;

module.exports = [
    { name: 'batch-namespacing: a single spec needs no namespace', run() {
        assert.deepEqual(fn()([{ specName: 'a', featurePaths: ['pets/pets.feature'] }]), [{}]);
    } },
    { name: 'batch-namespacing: several specs get data/schema prefixes; only colliding ones get sub-folders', run() {
        const r = fn()([
            { specName: 'a', featurePaths: ['pets/pets.feature'] },
            { specName: 'b', featurePaths: ['pets/pets.feature', 'x/x.feature'] },
            { specName: 'c', featurePaths: ['c/c.feature'] }
        ]);
        assert.deepEqual(r, [
            { filePrefix: 'a', subfolder: 'a' }, { filePrefix: 'b', subfolder: 'b' }, { filePrefix: 'c' }
        ]);
    } },
    { name: 'batch-namespacing: duplicate spec names stay unique', run() {
        const r = fn()([{ specName: 'api', featurePaths: [] }, { specName: 'API', featurePaths: [] }]);
        assert.notEqual(r[0].filePrefix.toLowerCase(), r[1].filePrefix.toLowerCase());
    } },
    { name: 'batch-namespacing: pet_store, pet-store and PetStore stay distinct after the planner slug', run() {
        const slug = require('../../out/generation/plan/slug').slug;
        const r = fn()(['pet_store', 'pet-store', 'PetStore'].map(specName => ({ specName, featurePaths: [] })));
        const slugs = r.map(x => slug(x.filePrefix));
        assert.equal(new Set(slugs).size, 3, slugs.join(','));
    } }
];
