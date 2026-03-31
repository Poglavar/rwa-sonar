const { isYes, isNo } = require('./utils');

describe('isYes', () => {
    test.each([
        ['yes', true],
        ['YES', true],
        ['  yes  ', true],
        ['y', true],
        ['Y', true],
        ['1', true],
        ['true', true],
        ['TRUE', true],
        ['no', false],
        ['0', false],
        ['false', false],
        ['maybe', false],
        ['', false],
        [null, false],
        [undefined, false],
    ])('isYes(%p) should be %p', (input, expected) => {
        expect(isYes(input)).toBe(expected);
    });
});

describe('isNo', () => {
    test.each([
        ['no', true],
        ['NO', true],
        ['  no  ', true],
        ['n', true],
        ['N', true],
        ['0', true],
        ['false', true],
        ['FALSE', true],
        ['yes', false],
        ['1', false],
        ['true', false],
        ['maybe', false],
        ['', false],
        [null, false],
        [undefined, false],
    ])('isNo(%p) should be %p', (input, expected) => {
        expect(isNo(input)).toBe(expected);
    });
});
