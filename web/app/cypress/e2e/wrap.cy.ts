describe('Wrap page', () => {
  it('shows validation when wallet is disconnected', () => {
    cy.visit('/wrap');
    cy.contains('Wrap tokens into zTokens').should('be.visible');
    cy.contains('Generate wrap proof & submit').click();
    cy.contains('Connect your wallet before wrapping.').should('be.visible');
  });
});
