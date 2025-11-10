describe('Unwrap page', () => {
  it('requires a connected wallet', () => {
    cy.visit('/unwrap');
    cy.contains('Unwrap zTokens').should('be.visible');
    cy.contains('Generate unwrap proof & submit').click();
    cy.contains('Connect your wallet before unwrapping.').should('be.visible');
  });
});
