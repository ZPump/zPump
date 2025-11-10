describe('Unshield page', () => {
  it('requires a connected wallet', () => {
    cy.visit('/unshield');
    cy.contains('Unshield tokens').should('be.visible');
    cy.contains('Generate proof & submit').click();
    cy.contains('Connect your wallet before unshielding.').should('be.visible');
  });
});
