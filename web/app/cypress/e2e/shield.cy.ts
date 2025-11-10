describe('Shield page', () => {
  it('shows validation when wallet is disconnected', () => {
    cy.visit('/shield');
    cy.contains('Shield tokens').should('be.visible');
    cy.contains('Generate proof & submit').click();
    cy.contains('Connect your wallet before shielding.').should('be.visible');
  });
});
