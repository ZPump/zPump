describe('Convert page', () => {
  it('loads and blocks submission without wallet', () => {
    cy.visit('/convert');
    cy.contains('Convert between public tokens and zTokens').should('be.visible');
    cy.contains('Submit conversion').click();
    cy.contains('Connect wallet to proceed').should('exist');
  });
});

