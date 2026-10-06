if (!customElements.get('product-form')) {
  customElements.define(
    'product-form',
    class ProductForm extends HTMLElement {
      constructor() {
        super();

        this.form = this.querySelector('form');
        this.variantIdInput.disabled = false;
        this.form.addEventListener('submit', this.onSubmitHandler.bind(this));
        this.cart = document.querySelector('cart-notification') || document.querySelector('cart-drawer');
        this.submitButton = this.querySelector('[type="submit"]');
        this.submitButtonText = this.submitButton.querySelector('span');

        if (document.querySelector('cart-drawer')) this.submitButton.setAttribute('aria-haspopup', 'dialog');

        this.hideErrors = this.dataset.hideErrors === 'true';
      }

      /**
       * Gift box add-on (snippets/gift-box-addon.liquid).
       * Returns { variantId, quantity } only when the add-on belongs to THIS product form
       * (same <product-info>), is visible and is ticked. Never used inside quick-add modals.
       */
      getGiftBoxSelection(formData) {
        if (this.closest('quick-add-modal')) return null;

        const wrapper = this.closest('product-info')?.querySelector('[data-gift-box]');
        if (!wrapper) return null;

        const checkbox = wrapper.querySelector('[data-gift-box-checkbox]');
        if (!checkbox || !checkbox.checked) return null;
        if (window.getComputedStyle(wrapper).display === 'none') return null;

        const variantId = wrapper.dataset.giftBoxVariantId;
        if (!variantId) return null;

        // Gift box quantity always follows the main product quantity.
        const qty = parseInt(formData?.get('quantity'), 10);
        return { variantId, quantity: Number.isFinite(qty) && qty > 0 ? qty : 1 };
      }

      addGiftBoxToCart(giftBox) {
        const config = fetchConfig('javascript');
        config.headers['X-Requested-With'] = 'XMLHttpRequest';
        delete config.headers['Content-Type'];

        const body = new FormData();
        body.append('id', giftBox.variantId);
        body.append('quantity', giftBox.quantity);
        config.body = body;

        return fetch(`${routes.cart_add_url}`, config).then((response) => response.json());
      }

      /**
       * Undo the gift box add when the main product could not be added,
       * so the cart never keeps an orphan gift box.
       */
      async rollbackGiftBox(giftResponse, addedQuantity) {
        if (!giftResponse || !giftResponse.key) return;

        const previousQuantity = Math.max(0, (Number(giftResponse.quantity) || addedQuantity) - addedQuantity);

        try {
          await fetch(`${routes.cart_change_url}`, {
            ...fetchConfig(),
            body: JSON.stringify({ id: giftResponse.key, quantity: previousQuantity }),
          });
        } catch (error) {
          console.error(error);
        }
      }

      async onSubmitHandler(evt) {
        evt.preventDefault();
        if (this.submitButton.getAttribute('aria-disabled') === 'true') return;

        this.handleErrorMessage();

        this.submitButton.setAttribute('aria-disabled', true);
        this.submitButton.classList.add('loading');
        this.querySelector('.loading__spinner').classList.remove('hidden');

        const config = fetchConfig('javascript');
        config.headers['X-Requested-With'] = 'XMLHttpRequest';
        delete config.headers['Content-Type'];

        const formData = new FormData(this.form);
        if (this.cart) {
          formData.append(
            'sections',
            this.cart.getSectionsToRender().map((section) => section.id)
          );
          formData.append('sections_url', window.location.pathname);
          this.cart.setActiveElement(document.activeElement);
        }
        config.body = formData;

        const giftBox = this.getGiftBoxSelection(formData);
        let giftResponse = null;
        let giftAdded = false;
        let mainAdded = false;

        try {
          // 1) Gift box first, so the cart sections rendered by the main add already include it.
          if (giftBox) {
            giftResponse = await this.addGiftBoxToCart(giftBox);

            if (giftResponse && giftResponse.status) {
              publish(PUB_SUB_EVENTS.cartError, {
                source: 'product-form',
                productVariantId: giftBox.variantId,
                errors: giftResponse.errors || giftResponse.description,
                message: giftResponse.message,
              });
              // Nothing was added. Keep the button usable so the customer can untick or retry.
              this.handleErrorMessage(giftResponse.description || giftResponse.message);
              return;
            }
            giftAdded = true;
          }

          // 2) Main product (original behaviour).
          const response = await fetch(`${routes.cart_add_url}`, config).then((res) => res.json());

          if (response.status) {
            if (giftAdded) await this.rollbackGiftBox(giftResponse, giftBox.quantity);

            publish(PUB_SUB_EVENTS.cartError, {
              source: 'product-form',
              productVariantId: formData.get('id'),
              errors: response.errors || response.description,
              message: response.message,
            });
            this.handleErrorMessage(response.description);

            const soldOutMessage = this.submitButton.querySelector('.sold-out-message');
            if (!soldOutMessage) return;
            this.submitButton.setAttribute('aria-disabled', true);
            this.submitButtonText.classList.add('hidden');
            soldOutMessage.classList.remove('hidden');
            this.error = true;
            return;
          } else if (!this.cart) {
            window.location = window.routes.cart_url;
            return;
          }

          mainAdded = true;

          const startMarker = CartPerformance.createStartingMarker('add:wait-for-subscribers');
          if (!this.error)
            publish(PUB_SUB_EVENTS.cartUpdate, {
              source: 'product-form',
              productVariantId: formData.get('id'),
              cartData: response,
            }).then(() => {
              CartPerformance.measureFromMarker('add:wait-for-subscribers', startMarker);
            });
          this.error = false;
          const quickAddModal = this.closest('quick-add-modal');
          if (quickAddModal) {
            document.body.addEventListener(
              'modalClosed',
              () => {
                setTimeout(() => {
                  CartPerformance.measure('add:paint-updated-sections', () => {
                    this.cart.renderContents(response);
                  });
                });
              },
              { once: true }
            );
            quickAddModal.hide(true);
          } else {
            CartPerformance.measure('add:paint-updated-sections', () => {
              this.cart.renderContents(response);
            });
          }
        } catch (e) {
          console.error(e);
          if (giftAdded && !mainAdded) await this.rollbackGiftBox(giftResponse, giftBox.quantity);
        } finally {
          this.submitButton.classList.remove('loading');
          if (this.cart && this.cart.classList.contains('is-empty')) this.cart.classList.remove('is-empty');
          if (!this.error) this.submitButton.removeAttribute('aria-disabled');
          this.querySelector('.loading__spinner').classList.add('hidden');

          CartPerformance.measureFromEvent('add:user-action', evt);
        }
      }

      handleErrorMessage(errorMessage = false) {
        if (this.hideErrors) return;

        this.errorMessageWrapper =
          this.errorMessageWrapper || this.querySelector('.product-form__error-message-wrapper');
        if (!this.errorMessageWrapper) return;
        this.errorMessage = this.errorMessage || this.errorMessageWrapper.querySelector('.product-form__error-message');

        this.errorMessageWrapper.toggleAttribute('hidden', !errorMessage);

        if (errorMessage) {
          this.errorMessage.textContent = errorMessage;
        }
      }

      toggleSubmitButton(disable = true, text) {
        if (disable) {
          this.submitButton.setAttribute('disabled', 'disabled');
          if (text) this.submitButtonText.textContent = text;
        } else {
          this.submitButton.removeAttribute('disabled');
          this.submitButtonText.textContent = window.variantStrings.addToCart;
        }
      }

      get variantIdInput() {
        return this.form.querySelector('[name=id]');
      }
    }
  );
}
