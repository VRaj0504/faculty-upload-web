// One entry per fixed-name course. Electives (e.g. "Elective - 2") are
// deliberately left out since their actual subject name varies per
// student and isn't fixed in the curriculum sheet.
export type CurriculumSubject = {
  code: string;
  name: string;
};

// Record<number, ...> here means "an object where every key is a semester
// number (1-8), and every value is an array of that semester's subjects."
export type BranchCurriculum = Record<number, CurriculumSubject[]>;

export const curriculum: Record<'CSE' | 'ECE' | 'MNC', BranchCurriculum> = {
  CSE: {
    1: [
      { code: 'CS101', name: 'Fundamentals of Computer & C Programming' },
      { code: 'AS101', name: 'Engineering Physics' },
      { code: 'MS101', name: 'Engineering Mathematics' },
      { code: 'AS102', name: 'Fundamentals of Biological Sciences' },
      { code: 'EC101', name: 'ICT Workshop - I' },
      { code: 'EC102', name: 'Introduction to Electrical Engineering' },
      { code: 'HS101', name: 'Communication Skills and Personality Development' },
    ],
    2: [
      { code: 'CS201', name: 'Data Structures and Algorithms using C' },
      { code: 'EC201', name: 'Digital Systems' },
      { code: 'MS201', name: 'Probability Theory and Stochastic Processes' },
      { code: 'MS202', name: 'Discrete Mathematics' },
      { code: 'CS202', name: 'ICT Workshop - II' },
      { code: 'HS201', name: 'Engineering Arts and Sciences' },
    ],
    3: [
      { code: 'CS301', name: 'Computer Organization and Architecture' },
      { code: 'CS302', name: 'Object Oriented Programming' },
      { code: 'CS303', name: 'Programming for Problem Solving' },
      { code: 'CS304', name: 'Database Management Systems' },
      { code: 'CS305', name: 'Software Engineering' },
      { code: 'HS301', name: 'Economics & Business Management' },
    ],
    4: [
      { code: 'CS401', name: 'Operating System' },
      { code: 'MS401', name: 'Numerical Analysis' },
      { code: 'CS402', name: 'Data Science' },
      { code: 'CS403', name: 'Design Analysis and Algorithm' },
      { code: 'CS404', name: 'Formal Language and Automata Theory' },
      { code: 'EC405', name: 'Analog & Digital Communication' },
    ],
    5: [
      { code: 'CS501', name: 'Compiler Design' },
      { code: 'CS502', name: 'Computer Networks' },
      { code: 'CS503', name: 'Artificial Intelligence' },
      { code: 'MS501', name: 'Mathematical Optimization' },
      { code: 'HS501', name: 'Innovation & Entrepreneurship' },
    ],
    6: [
      { code: 'CS601', name: 'Machine Learning' },
      { code: 'CS602', name: 'Information Security' },
      { code: 'CS603', name: 'Cloud Computing' },
      { code: 'CS604', name: 'Mini Project' },
    ],
    7: [
      { code: 'CS701', name: 'Advanced AI/ML' },
      { code: 'CS702', name: 'Internet of Things' },
      { code: 'CS703', name: 'Parallel and Distributed Systems' },
      { code: 'HS701', name: 'Program Management' },
    ],
    8: [
      { code: 'CS801', name: 'B.Tech. Project' },
    ],
  },
  ECE: {
    1: [
      { code: 'CS101', name: 'Fundamentals of Computers & Programming' },
      { code: 'AS101', name: 'Engineering Physics' },
      { code: 'MS101', name: 'Engineering Mathematics' },
      { code: 'AS102', name: 'Fundamentals of Biological Sciences' },
      { code: 'EC101', name: 'ICT Workshop - I' },
      { code: 'EC102', name: 'Introduction to Electrical Engineering' },
      { code: 'HS101', name: 'Communication Skills and Personality Development' },
    ],
    2: [
      { code: 'CS201', name: 'Data Structure and Algorithms using C' },
      { code: 'EC201', name: 'Digital Systems' },
      { code: 'MS201', name: 'Probability Theory and Stochastic Processes' },
      { code: 'MS202', name: 'Discrete Mathematics' },
      { code: 'CS202', name: 'ICT Workshop - II' },
      { code: 'HS201', name: 'Engineering Arts and Sciences' },
    ],
    3: [
      { code: 'CS301', name: 'Computer Organization and Architecture' },
      { code: 'EC301', name: 'Signal and Systems' },
      { code: 'CS303', name: 'Programming for Problem Solving' },
      { code: 'EC302', name: 'Electronics Devices and Circuits' },
      { code: 'EC303', name: 'Sensors and Instrumentation' },
      { code: 'HS301', name: 'Economics & Business Management' },
    ],
    4: [
      { code: 'CS401', name: 'Operating System' },
      { code: 'EC401', name: 'Control System' },
      { code: 'CS402', name: 'Data Science' },
      { code: 'EC402', name: 'Communication Systems' },
      { code: 'EC403', name: 'Engineering Electromagnetics' },
      { code: 'EC404', name: 'Modern Energy Systems' },
    ],
    5: [
      { code: 'EC501', name: 'Semiconductor Technology' },
      { code: 'CS502', name: 'Computer Networks' },
      { code: 'EC502', name: 'Analog Integrated Circuits' },
      { code: 'EC503', name: 'Embedded Systems' },
      { code: 'HS501', name: 'Innovation & Entrepreneurship' },
    ],
    6: [
      { code: 'EC601', name: 'Digital VLSI Design' },
      { code: 'CS603', name: 'Cloud Computing' },
      { code: 'CS605', name: 'Artificial Intelligence and Machine Learning' },
      { code: 'EC604', name: 'Mini Project' },
    ],
    7: [
      { code: 'EC701', name: 'Digital Signal Processing' },
      { code: 'CS702', name: 'Internet of Things' },
      { code: 'EC702', name: 'Wireless Communication' },
      { code: 'HS701', name: 'Program Management' },
    ],
    8: [
      { code: 'EC801', name: 'B.Tech. Project' },
    ],
  },

  MNC: {
    1: [
      { code: 'CS101', name: 'Fundamentals of Computer & C Programming' },
      { code: 'AS101', name: 'Engineering Physics' },
      { code: 'MS101', name: 'Engineering Mathematics' },
      { code: 'AS102', name: 'Fundamentals of Biological Sciences' },
      { code: 'EC101', name: 'ICT Workshop - I' },
      { code: 'EC102', name: 'Introduction to Electrical Engineering' },
      { code: 'HS101', name: 'Communication Skills and Personality Development' },
    ],
    2: [
      { code: 'CS201', name: 'Data Structures and Algorithms using C' },
      { code: 'EC201', name: 'Digital Systems' },
      { code: 'MS201', name: 'Probability Theory and Stochastic Processes' },
      { code: 'MS202', name: 'Discrete Mathematics' },
      { code: 'CS202', name: 'ICT Workshop - II' },
      { code: 'HS201', name: 'Engineering Arts and Sciences' },
    ],
    3: [
      { code: 'MS301', name: 'Elements of Analysis' },
      { code: 'CS302', name: 'Object-Oriented Programming' },
      { code: 'CS306', name: 'Artificial Intelligence' },
      { code: 'CS304', name: 'Database Management Systems' },
      { code: 'MS303', name: 'Linear Algebra for AI/ML' },
      { code: 'HS301', name: 'Economics & Business Management' },
    ],
    4: [
      { code: 'MS402', name: 'Machine Learning' },
      { code: 'MS401', name: 'Numerical Analysis' },
      { code: 'CS402', name: 'Foundations of Data Science' },
      { code: 'CS403', name: 'Design Analysis and Algorithm' },
      { code: 'CS404', name: 'Formal Language and Automata Theory' },
      { code: 'CS401', name: 'Operating System' },
    ],
    5: [
      { code: 'CS506', name: 'Deep Learning' },
      { code: 'MS503', name: 'Multivariate Calculus & Measure Theory' },
      { code: 'MS505', name: 'Partial Differential Equations & Transforms' },
      { code: 'MS501', name: 'Mathematical Optimization' },
      { code: 'MS504', name: 'Mini Project' },
    ],
    6: [
      { code: 'MS601', name: 'Introduction to Large Language Models in NLP' },
      { code: 'CS602', name: 'Cryptography & Information Security' },
      { code: 'MS602', name: 'Multivariate Statistical Analysis' },
      { code: 'HS601', name: 'Innovation & Entrepreneurship' },
    ],
    7: [
      { code: 'MS701', name: 'Matrix Computations' },
      { code: 'MS702', name: 'Applied Deep Learning' },
      { code: 'CS703', name: 'Parallel and Distributed Systems' },
      { code: 'HS701', name: 'Program Management / Cognitive Science / Data & Society' },
    ],
    8: [
      { code: 'CS801', name: 'B.Tech. Project' },
    ],
  },
};