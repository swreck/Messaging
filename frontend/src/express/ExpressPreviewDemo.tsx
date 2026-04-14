// Express Flow — Interpretation Preview demo page
//
// TEMPORARY route for session 1: renders InterpretationPreview against mock
// data so the shape and tone can be reviewed before the real extraction
// endpoint is wired in. This page will be removed or repurposed once the
// chat-first entry surface ships in a later session.
//
// Route: /express-preview-demo (protected, admin nav not added — URL only)

import { InterpretationPreview } from './InterpretationPreview';
import type { ExpressInterpretation } from './types';
import { useToast } from '../shared/ToastContext';

const MOCK_INTERPRETATION: ExpressInterpretation = {
  offering: {
    name: 'GreenLeaf Fresh',
    nameSource: 'stated',
    description:
      'A B2B organic produce delivery service for restaurants. GreenLeaf Fresh sources directly from certified organic farms within 200 miles and delivers next-morning. Restaurants get traceable, seasonal ingredients with guaranteed freshness and stable pricing.',
    differentiators: [
      { text: 'Direct farm sourcing within 200 miles', source: 'stated' },
      { text: 'Next-morning delivery guaranteed', source: 'stated' },
      { text: 'Stable seasonal pricing with no surge markups', source: 'stated' },
      { text: 'Full traceability from farm to kitchen', source: 'stated' },
      { text: 'Certified organic farms only', source: 'inferred' },
      { text: 'Seasonal ingredients chosen for the week', source: 'inferred' },
    ],
  },
  audiences: [
    {
      name: 'Restaurant operator or executive chef at an independent or small-chain restaurant',
      description:
        'A buyer — likely an owner-operator, executive chef, or kitchen manager — responsible for sourcing ingredients for a restaurant that cares about food quality and provenance. They manage supplier relationships and make purchasing decisions.',
      source: 'inferred',
      priorities: [
        {
          text: 'Keeping food costs predictable so margins do not get destroyed by price swings',
          source: 'inferred',
        },
        {
          text: 'Knowing the ingredients on the plate are what they claim to be — origin, quality, certifications',
          source: 'inferred',
        },
        {
          text: 'Reliable delivery so prep and service are not disrupted by late or missing orders',
          source: 'inferred',
        },
        {
          text: 'Being able to tell a credible local and organic sourcing story to guests',
          source: 'inferred',
        },
        {
          text: 'Reducing the hassle of vetting and managing multiple produce suppliers',
          source: 'inferred',
        },
      ],
    },
  ],
  primaryMedium: {
    value: 'email',
    source: 'stated',
    reasoning: 'You mentioned wanting to reach potential customers with an outreach note.',
  },
  confidenceNotes:
    'The offering details were all clearly stated. I had to guess at the audience — you mentioned restaurants, but not which role inside the restaurant buys produce. I went with an owner or executive chef since that is typical for independent kitchens, but if you are targeting a different role inside the restaurant, change it here and the email will read right.',
};

export function ExpressPreviewDemo() {
  const { showToast } = useToast();

  return (
    <div className="express-page">
      <div className="express-header">
        <h1>Express Flow — Preview Demo</h1>
        <p className="express-page-hint">
          This is a development preview. The interpretation below is mock data so the shape and
          tone can be reviewed before the real chat surface is wired in. Nothing here writes to
          the database.
        </p>
      </div>

      <InterpretationPreview
        initial={MOCK_INTERPRETATION}
        onConfirm={edited => {
          console.log('CONFIRM (mock)', edited);
          showToast(
            'Mock confirmed. In the real flow, this would start building your first draft.',
          );
        }}
        onSwitchToWizard={edited => {
          console.log('SWITCH TO WIZARD (mock)', edited);
          showToast(
            'Mock wizard handoff. In the real flow, this would hand off to the step-by-step wizard.',
          );
        }}
      />
    </div>
  );
}
