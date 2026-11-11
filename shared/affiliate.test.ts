import { describe, expect, it } from 'vitest';
import { AFFILIATE_CODE_PATTERN, affiliateCodePrefix, affiliateLink, maskCustomerName } from './affiliate';

describe('maskCustomerName', () => {
  it.each([
    ['Amel Benali', 'Amel B.'],
    ['  Amel   Benali  ', 'Amel B.'],
    ['Amel B', 'Amel B.'],
    ['Amel', 'Amel'],
    ['Jean-Pierre Dupont', 'Jean-Pierre D.'],
    ['Amel Ben-Ali', 'Amel B.'],
    ['Élodie Éluard', 'Élodie É.'],
    ['élodie élu', 'élodie É.'],
    ['Aïcha Ouédraogo', 'Aïcha O.'],
    ['Nour El Houda Benali', 'Nour B.'],
    ['Fatima Zohra Belkacemi', 'Fatima B.'],
    ["Sarah O'Brien", "Sarah O."],
    ['', 'Client'],
    ['   ', 'Client'],
    ['Amel.Benali', 'Amel B.'],
    ['Benali,Amel', 'Benali A.'],
    ['Amel_Benali', 'Amel B.'],
    ['Amel/Benali', 'Amel B.'],
    ['Amel...Benali.', 'Amel B.'],
    ['Amel 😀 Benali', 'Amel B.'],
    ['😀', 'Client'],
    ['...', 'Client'],
    ['Zoë-Anne,Ñuñez', 'Zoë-Anne Ñ.'],
    [' Amel Benali', 'Amel B.'],
  ])('%j -> %j', (input, expected) => {
    expect(maskCustomerName(input)).toBe(expected);
  });

  it('never lets a phone number, an e-mail or other digits typed into the name field through', () => {
    expect(maskCustomerName('0612345678 Amel')).toBe('Amel');
    expect(maskCustomerName('0612345678')).toBe('Client');
    expect(maskCustomerName('Amel 0612345678')).toBe('Amel');
    expect(maskCustomerName('amel@example.com Benali')).toBe('Benali');
    expect(maskCustomerName('Amel B2')).toBe('Amel');
    expect(maskCustomerName('+213 612 345 678 Amel')).toBe('Amel');
  });

  it('caps a very long first name and handles code points outside the BMP', () => {
    expect(maskCustomerName('A'.repeat(100) + ' Benali')).toBe('A'.repeat(30) + ' B.');
    expect(maskCustomerName('Amel 𝓑enali')).toBe('Amel 𝓑.');
  });

  it('keeps Arabic names (letters of any script) and masks the last name', () => {
    expect(maskCustomerName('أمل بن علي')).toBe('أمل ع.');
  });
});

describe('affiliate codes', () => {
  it.each([
    ['Aya Benali', 'AYA'],
    ['  élodie Dupont', 'ELO'],
    ['Zoë', 'ZOE'],
    ['Li', 'LIX'],
    ['A', 'AXX'],
    ['', 'XXX'],
    ['1234', 'XXX'],
    ['Æsir Øye', 'AES'],
    ['Ça va', 'CAV'],
    ['Jean-Pierre', 'JEA'],
    ['أمل', 'XXX'],
    ['Ñoño', 'NON'],
    ['ß', 'SSX'],
  ])('%j -> prefix %j', (name, prefix) => {
    expect(affiliateCodePrefix(name)).toBe(prefix);
  });

  it('matches the pattern for three-digit and longer sequences only', () => {
    for (const ok of ['AYA001', 'AYA999', 'AYA1000', 'XXX012']) expect(AFFILIATE_CODE_PATTERN.test(ok)).toBe(true);
    for (const bad of ['aya001', 'AYA01', 'AY001', 'AYA001 ', 'AYA00A', '', 'AYAA001', ' AYA001', 'AYA001\n']) expect(AFFILIATE_CODE_PATTERN.test(bad)).toBe(false);
  });

  it('builds the link from the app origin', () => {
    expect(affiliateLink('https://darling7.store', 'AYA001')).toBe('https://darling7.store/?ref=AYA001');
    expect(affiliateLink('https://darling7.store/', 'AYA001')).toBe('https://darling7.store/?ref=AYA001');
  });
});
